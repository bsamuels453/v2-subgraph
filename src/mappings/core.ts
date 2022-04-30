import {
  BigInt,
  BigDecimal,
  store,
  Address,
  log,
  Bytes,
} from '@graphprotocol/graph-ts';
import {
  Pair,
  Token,
  UniswapFactory,
  Transaction,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
  Bundle,
} from '../types/schema';
import {
  Pair as PairContract,
  Mint,
  Burn,
  Swap,
  Transfer,
  Sync,
} from '../types/templates/Pair/Pair';
import {
  updatePairDayData,
  updateTokenDayData,
  updateUniswapDayData,
  updatePairHourData,
} from './dayUpdates';
import {
  getEthPriceInUSD,
  findEthPerToken,
  getTrackedVolumeUSD,
  getTrackedLiquidityUSD,
} from './pricing';
import {
  convertTokenToDecimal,
  ADDRESS_ZERO,
  FACTORY_ADDRESS,
  ONE_BI,
  getOrCreateUser,
  ZERO_BD,
  BI_18,
  loadTokenOrFail,
  loadPairOrFail,
  loadFactoryOrFail,
  loadBundleOrFail,
  loadTransactionOrFail,
  isRouter,
  getSwapCreditor,
  recognizeTokenSale,
  recognizeTokenPurchase,
} from './helpers';

export function handleTransfer(event: Transfer): void {
  // ignore initial transfers for first adds
  if (
    event.params.to.toHexString() == ADDRESS_ZERO &&
    event.params.value.equals(BigInt.fromI32(1000))
  ) {
    return;
  }

  // user stats
  let from = event.params.from;
  getOrCreateUser(from.toHexString());
  let to = event.params.to;
  getOrCreateUser(to.toHexString());

  // get pair and load contract
  let pair = loadPairOrFail(event.address.toHexString());

  // liquidity token amount being transfered
  let value = convertTokenToDecimal(event.params.value, BI_18);

  // get or create transaction
  let transaction = Transaction.load(event.transaction.hash.toHexString());
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHexString());
    transaction.blockNumber = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.swaps = [];
  }

  if (from.toHexString() == ADDRESS_ZERO) {
    // update total supply
    pair.totalSupply = pair.totalSupply.plus(value);
    pair.save();
  }

  if (
    event.params.to.toHexString() == ADDRESS_ZERO &&
    event.params.from.toHexString() == pair.id
  ) {
    pair.totalSupply = pair.totalSupply.minus(value);
    pair.save();
  }

  transaction.save();
}

export function handleSync(event: Sync): void {
  let pair = loadPairOrFail(event.address.toHexString());
  let uniswap = loadFactoryOrFail(FACTORY_ADDRESS);
  let token0 = loadTokenOrFail(pair.token0);
  let token1 = loadTokenOrFail(pair.token1);

  // reset factory liquidity by subtracting onluy tarcked liquidity
  uniswap.totalLiquidityETH = uniswap.totalLiquidityETH.minus(
    pair.trackedReserveETH as BigDecimal
  );

  // reset token total liquidity amounts
  token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1);

  pair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals);
  pair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals);

  if (pair.reserve1.notEqual(ZERO_BD))
    pair.token0Price = pair.reserve0.div(pair.reserve1);
  else pair.token0Price = ZERO_BD;
  if (pair.reserve0.notEqual(ZERO_BD))
    pair.token1Price = pair.reserve1.div(pair.reserve0);
  else pair.token1Price = ZERO_BD;

  pair.save();

  // update ETH price now that reserves could have changed
  let bundle = loadBundleOrFail('1');
  bundle.ethPrice = getEthPriceInUSD();
  bundle.save();
  //if(bundle.lastUpdated.lt(event.block.number)){
  //	bundle.lastUpdated = event.block.number;
  //}

  token0.derivedETH = findEthPerToken(token0 as Token);
  token1.derivedETH = findEthPerToken(token1 as Token);
  token0.save();
  token1.save();

  // get tracked liquidity - will be 0 if neither is in whitelist
  let trackedLiquidityETH: BigDecimal;
  if (bundle.ethPrice.notEqual(ZERO_BD)) {
    trackedLiquidityETH = getTrackedLiquidityUSD(
      pair.reserve0,
      token0 as Token,
      pair.reserve1,
      token1 as Token
    ).div(bundle.ethPrice);
  } else {
    trackedLiquidityETH = ZERO_BD;
  }

  // use derived amounts within pair
  pair.trackedReserveETH = trackedLiquidityETH;
  pair.reserveETH = pair.reserve0
    .times(token0.derivedETH as BigDecimal)
    .plus(pair.reserve1.times(token1.derivedETH as BigDecimal));
  pair.reserveUSD = pair.reserveETH.times(bundle.ethPrice);

  // use tracked amounts globally
  uniswap.totalLiquidityETH = uniswap.totalLiquidityETH.plus(
    trackedLiquidityETH
  );
  uniswap.totalLiquidityUSD = uniswap.totalLiquidityETH.times(bundle.ethPrice);

  // now correctly set liquidity amounts for each token
  token0.totalLiquidity = token0.totalLiquidity.plus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.plus(pair.reserve1);

  // save entities
  pair.save();
  uniswap.save();
  token0.save();
  token1.save();
}

export function handleSwap(event: Swap): void {
  let pair = loadPairOrFail(event.address.toHexString());

  let token0 = loadTokenOrFail(pair.token0);
  let token1 = loadTokenOrFail(pair.token1);

  let amount0In = convertTokenToDecimal(
    event.params.amount0In,
    token0.decimals
  );

  let amount1In = convertTokenToDecimal(
    event.params.amount1In,
    token1.decimals
  );
  let amount0Out = convertTokenToDecimal(
    event.params.amount0Out,
    token0.decimals
  );
  let amount1Out = convertTokenToDecimal(
    event.params.amount1Out,
    token1.decimals
  );

  // totals for volume updates
  let amount0Total = amount0Out.plus(amount0In);
  let amount1Total = amount1Out.plus(amount1In);

  // ETH/USD prices
  let bundle = loadBundleOrFail('1');

  let derivedAmountETH = token1.derivedETH
    .times(amount1Total)
    .plus(token0.derivedETH.times(amount0Total))
    .div(BigDecimal.fromString('2'));

  let derivedAmountUSD = derivedAmountETH.times(bundle.ethPrice);

  // only accounts for volume through white listed tokens
  let trackedAmountUSD = getTrackedVolumeUSD(
    amount0Total,
    token0 as Token,
    amount1Total,
    token1 as Token,
    pair as Pair
  );

  let trackedAmountETH: BigDecimal;
  if (bundle.ethPrice.equals(ZERO_BD)) {
    trackedAmountETH = ZERO_BD;
  } else {
    trackedAmountETH = trackedAmountUSD.div(bundle.ethPrice);
  }

  // update token0 global volume and token liquidity stats
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out));
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD);
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD);

  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out));
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD);
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD);

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI);
  token1.txCount = token1.txCount.plus(ONE_BI);

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD);
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total);
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total);
  pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD);
  pair.txCount = pair.txCount.plus(ONE_BI);
  pair.save();

  // update global values, only used tracked amounts for volume
  let uniswap = loadFactoryOrFail(FACTORY_ADDRESS);

  uniswap.totalVolumeUSD = uniswap.totalVolumeUSD.plus(trackedAmountUSD);
  uniswap.totalVolumeETH = uniswap.totalVolumeETH.plus(trackedAmountETH);
  uniswap.untrackedVolumeUSD = uniswap.untrackedVolumeUSD.plus(
    derivedAmountUSD
  );
  uniswap.txCount = uniswap.txCount.plus(ONE_BI);

  // save entities
  pair.save();
  token0.save();
  token1.save();
  uniswap.save();

  let transaction = Transaction.load(event.transaction.hash.toHexString());
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHexString());
    transaction.blockNumber = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.multiLegSwapInProgress = false;
    transaction.swaps = [];
    transaction.multiswapBeneficiary = null;
  }
  let swaps = transaction.swaps;
  let swap = new SwapEvent(
    event.transaction.hash
      .toHexString()
      .concat('-')
      .concat(swaps.length.toString())
  );

  // update swap event
  swap.transaction = transaction.id;
  swap.pair = pair.id;
  swap.timestamp = transaction.timestamp;
  swap.transaction = transaction.id;
  swap.sender = event.params.sender;
  swap.amount0In = amount0In;
  swap.amount1In = amount1In;
  swap.amount0Out = amount0Out;
  swap.amount1Out = amount1Out;
  swap.costBasis = null;
  //
  swap.from = event.transaction.from;
  swap.logIndex = event.logIndex;

  let txnTo = ADDRESS_ZERO; //contract create
  if (event.transaction.to) {
    txnTo = event.transaction.to!.toHexString();
  }

  swap.txnTarget = Bytes.fromHexString(txnTo);

  // use the tracked amount if we have it
  swap.amountUSD =
    trackedAmountUSD === ZERO_BD ? derivedAmountUSD : trackedAmountUSD;

  let swapInitiatedByRouter = false;
  let sender = swap.sender.toHexString();
  let toAddress = event.params.to.toHexString();
  if (isRouter(sender)) {
    swapInitiatedByRouter = true;
  }
  swap.routerSwap = swapInitiatedByRouter;

  if (isRouter(toAddress)) {
    // This is swapTokensForEth. Router is transfering tokens to itself before unwrapping.
    // We're going to assume that no smart contract out there will ever want to use swapForEth over swapForTokens
    toAddress = event.transaction.from.toHexString();
  }

  let fromAddress = swap.from.toHexString();
  let nextHopIsPair = false;
  // check for multi-leg swaps
  if (
    toAddress != sender &&
    sender != fromAddress &&
    fromAddress != toAddress
  ) {
    let toPair = Pair.load(toAddress);
    if (toPair) {
      nextHopIsPair = true;
    }
  }

  if (!transaction.multiLegSwapInProgress) {
    // calc cost basis of origin txn
    log.info('Recognizing token sale for tx {} pair {} fromAddress: {}', [
      transaction.id,
      pair.id,
      fromAddress,
    ]);
    let debitor = getSwapCreditor(sender, fromAddress, event.transaction);
    let isEOA = debitor == fromAddress ? true : false;

    // Under some conditions, amount0In AND amount1In will both be non-zero.
    // probably caused by morons sending their tokens to the pair and forgetting to call swap.
    // MEV opportunity? lol

    // also note how there can be 2 values populated for amountOut. This only happens for smart contracts trying to be clever about gas use, so we lazily assume the lesser of the two tokens being received is the token being sold.

    if (amount0Out.lt(amount1Out)) {
      // token0 is the token being sold
      let cb = recognizeTokenSale(
        pair.token0,
        amount0In,
        swap.amountUSD,
        debitor,
        isEOA
      );
      if (cb) {
        swap.costBasis = cb.id;
        cb.swapCount = cb.swapCount.plus(BigInt.fromI32(1));
        cb.save();
      }
    } else {
      // token1 is the token being solds
      let cb = recognizeTokenSale(
        pair.token1,
        amount1In,
        swap.amountUSD,
        debitor,
        isEOA
      );
      if (cb) {
        swap.costBasis = cb.id;
        cb.swapCount = cb.swapCount.plus(BigInt.fromI32(1));
        cb.save();
      }
    }
  }

  if (nextHopIsPair) {
    swap.accounted = false;
    transaction.multiLegSwapInProgress = true;
    log.info('Starting multiswap txn for tx {}', [transaction.id]);
  } else {
    swap.accounted = true;
    transaction.multiLegSwapInProgress = false;
    //let isEOA = toAddress == fromAddress ? true : false;

    recognizeTokenPurchase(
      pair.token0,
      amount0Out,
      swap.amountUSD,
      toAddress,
      false
    );
    recognizeTokenPurchase(
      pair.token1,
      amount1Out,
      swap.amountUSD,
      toAddress,
      false
    );

    // calc cost basis of purchase

    //if (transaction.multiLegSwapInProgress) {
    // calc cost basis of origin transaction
    //} else {
    // calc cost basis from sent tokens/eth
    //}
  }

  // calc cost basis for dest leg of swap (but only if we aren't in an active multiswap)

  swap.to = Address.fromString(toAddress);
  swap.save();

  // update the transaction

  // TODO: Consider using .concat() for handling array updates to protect
  // against unintended side effects for other code paths.
  swaps.push(swap.id);
  transaction.swaps = swaps;
  transaction.save();

  // update day entities
  let pairDayData = updatePairDayData(event);
  let pairHourData = updatePairHourData(event);
  let uniswapDayData = updateUniswapDayData(event);
  let token0DayData = updateTokenDayData(token0 as Token, event);
  let token1DayData = updateTokenDayData(token1 as Token, event);

  // swap specific updating
  uniswapDayData.dailyVolumeUSD = uniswapDayData.dailyVolumeUSD.plus(
    trackedAmountUSD
  );
  uniswapDayData.dailyVolumeETH = uniswapDayData.dailyVolumeETH.plus(
    trackedAmountETH
  );
  uniswapDayData.dailyVolumeUntracked = uniswapDayData.dailyVolumeUntracked.plus(
    derivedAmountUSD
  );
  uniswapDayData.save();

  // swap specific updating for pair
  pairDayData.dailyVolumeToken0 = pairDayData.dailyVolumeToken0.plus(
    amount0Total
  );
  pairDayData.dailyVolumeToken1 = pairDayData.dailyVolumeToken1.plus(
    amount1Total
  );
  pairDayData.dailyVolumeUSD = pairDayData.dailyVolumeUSD.plus(
    trackedAmountUSD
  );
  pairDayData.save();

  // update hourly pair data
  pairHourData.hourlyVolumeToken0 = pairHourData.hourlyVolumeToken0.plus(
    amount0Total
  );
  pairHourData.hourlyVolumeToken1 = pairHourData.hourlyVolumeToken1.plus(
    amount1Total
  );
  pairHourData.hourlyVolumeUSD = pairHourData.hourlyVolumeUSD.plus(
    trackedAmountUSD
  );
  pairHourData.save();

  // swap specific updating for token0
  token0DayData.dailyVolumeToken = token0DayData.dailyVolumeToken.plus(
    amount0Total
  );
  token0DayData.dailyVolumeETH = token0DayData.dailyVolumeETH.plus(
    amount0Total.times(token0.derivedETH as BigDecimal)
  );
  token0DayData.dailyVolumeUSD = token0DayData.dailyVolumeUSD.plus(
    amount0Total.times(token0.derivedETH as BigDecimal).times(bundle.ethPrice)
  );
  token0DayData.save();

  // swap specific updating
  token1DayData.dailyVolumeToken = token1DayData.dailyVolumeToken.plus(
    amount1Total
  );
  token1DayData.dailyVolumeETH = token1DayData.dailyVolumeETH.plus(
    amount1Total.times(token1.derivedETH as BigDecimal)
  );
  token1DayData.dailyVolumeUSD = token1DayData.dailyVolumeUSD.plus(
    amount1Total.times(token1.derivedETH as BigDecimal).times(bundle.ethPrice)
  );
  token1DayData.save();
}
