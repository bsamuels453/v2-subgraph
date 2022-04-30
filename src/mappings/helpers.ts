/* eslint-disable prefer-const */
import {
  log,
  BigInt,
  BigDecimal,
  Address,
  ethereum,
  Entity,
  Bytes,
  dataSource,
} from '@graphprotocol/graph-ts';
import { ERC20 } from '../types/Factory/ERC20';
import { ERC20SymbolBytes } from '../types/Factory/ERC20SymbolBytes';
import { ERC20NameBytes } from '../types/Factory/ERC20NameBytes';
import {
  User,
  Bundle,
  Token,
  Pair,
  UniswapFactory,
  Transaction,
  PairLookup,
  TokenCostBasis,
} from '../types/schema';
import { Factory as FactoryContract } from '../types/templates/Pair/Factory';
import { TokenDefinition } from './tokenDefinition';

export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';
export const FACTORY_ADDRESS = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';

export let ZERO_BI = BigInt.fromI32(0);
export let ONE_BI = BigInt.fromI32(1);
export let ZERO_BD = BigDecimal.fromString('0');
export let ONE_BD = BigDecimal.fromString('1');
export let BI_18 = BigInt.fromI32(18);

export let factoryContract = FactoryContract.bind(
  Address.fromString(FACTORY_ADDRESS)
);

// rebass tokens, dont count in tracked volume
export let UNTRACKED_PAIRS: string[] = [
  '0x9ea3b5b4ec044b70375236a281986106457b20ef',
];

export function getOrCreateTokenCostBasis(
  userAddress: string,
  tokenAddress: string,
  smartContractRuledOut: boolean
): TokenCostBasis {
  let id = userAddress.concat(tokenAddress);

  let costBasis = TokenCostBasis.load(id);
  if (costBasis) {
    if (!costBasis.smartContractRuledOut && smartContractRuledOut) {
      costBasis.smartContractRuledOut = true;
      costBasis.save();
      //let ds = dataSource.address();
      //log.critical(
      //  'Cost basis calc for user {} has error. Swap with token {} claims isEOA: {} datasource: {} ',
      //  [userAddress, tokenAddress, smartContractRuledOut ? 'true' : 'false', ds.toHexString()]
      //);
    }
    return costBasis;
  } else {
    let user = getOrCreateUser(userAddress);

    costBasis = new TokenCostBasis(id);
    costBasis.user = user.id;
    costBasis.token = tokenAddress;
    costBasis.usdCostBasis = BigDecimal.zero();
    costBasis.outstandingTokens = BigDecimal.zero();
    costBasis.consumedTokens = BigDecimal.zero();
    costBasis.usdTotalProfit = BigDecimal.zero();
    costBasis.usdTotalLoss = BigDecimal.zero();
    costBasis.usdTotalNetProceeds = BigDecimal.zero();
    costBasis.unrecognizableTokens = BigDecimal.zero();
    costBasis.smartContractRuledOut = smartContractRuledOut;
    costBasis.swapCount = BigInt.zero();
    costBasis.save();

    let test = TokenCostBasis.load(id);

    if (test!.user === null) {
      log.critical('user was null', []);
    }
    return costBasis;
  }
}

export function loadTokenOrFail(address: string): Token {
  let token = Token.load(address);
  if (!token) {
    log.critical('No token entity populated for address  {}', [address]);
    return token!;
  } else {
    return token;
  }
}

export function loadTransactionOrFail(hash: string): Transaction {
  let txn = Transaction.load(hash);
  if (!txn) {
    log.critical('No transaction entity for hash {}', [hash]);
    return txn!;
  } else {
    return txn;
  }
}

export function loadPairOrFail(address: string): Pair {
  let pair = Pair.load(address);
  if (!pair) {
    log.critical('No pair entity populated for address {}', [address]);
    return pair!;
  } else {
    return pair;
  }
}

export function getPairLookupId(tokenA: string, tokenB: string): string {
  let tokenAValue = BigInt.fromUnsignedBytes(Bytes.fromHexString(tokenA));
  let tokenBValue = BigInt.fromUnsignedBytes(Bytes.fromHexString(tokenB));

  if (tokenAValue.lt(tokenBValue)) {
    return tokenA.concat(tokenB);
  } else {
    return tokenB.concat(tokenA);
  }
}

export function loadPairIfExists(tokenA: string, tokenB: string): Pair | null {
  let id = getPairLookupId(tokenA, tokenB);
  let lookup = PairLookup.load(id);
  if (!lookup) {
    return null;
  } else {
    return Pair.load(lookup.pair)!;
  }
}

export function loadFactoryOrFail(address: string): UniswapFactory {
  let factory = UniswapFactory.load(address);
  if (!factory) {
    log.critical('No factory entity populated for address {}', [address]);
    return factory!;
  } else {
    return factory;
  }
}

export function loadBundleOrFail(id: string): Bundle {
  let bundle = Bundle.load(id);
  if (!bundle) {
    log.critical('No bundle entity at {}', [id]);
    return bundle!;
  } else {
    return bundle;
  }
}

export function isRouter(address: string): boolean {
  const UNISWAP_ROUTER_2 = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
  const UNISWAP_ROUTER_1 = '0xf164fc0ec4e93095b804a4795bbe1e041497b92a';

  if (address == UNISWAP_ROUTER_1 || address == UNISWAP_ROUTER_2) {
    return true;
  } else {
    return false;
  }
}

export function getSwapCreditor(
  swapSender: string,
  swapFrom: string,
  transaction: ethereum.Transaction
): string {
  // if sender is the router && txn.to == router, the debitor is the fromAddress
  // if sender is the router && txn.to != router, no idea. probably txn.to.
  // otherwise, creditor is sender.

  let txnTo = ADDRESS_ZERO; //contract create
  if (transaction.to) {
    txnTo = transaction.to!.toHexString();
  }

  if (isRouter(swapSender)) {
    if (isRouter(txnTo)) {
      return swapFrom;
    } else {
      return txnTo;
    }
  } else {
    return swapSender;
  }
}

export function recognizeTokenPurchase(
  tokenId: string,
  tokensPurchased: BigDecimal,
  txValueUsd: BigDecimal,
  debitorAddress: string,
  isEOA: boolean
): void {
  if (tokensPurchased.equals(BigDecimal.zero())) {
    return;
  }

  let costBasis = getOrCreateTokenCostBasis(debitorAddress, tokenId, isEOA);

  let purchaseCostBasis = txValueUsd.div(tokensPurchased);
  let denominator = costBasis.outstandingTokens.plus(tokensPurchased);

  let prodNew = tokensPurchased.div(denominator);
  let prodOld = costBasis.outstandingTokens.div(denominator);

  let newCBContribution = purchaseCostBasis.times(prodNew);
  let oldCBContribution = costBasis.usdCostBasis.times(prodOld);
  let avgCostBasis = newCBContribution.plus(oldCBContribution);

  costBasis.outstandingTokens = costBasis.outstandingTokens.plus(
    tokensPurchased
  );
  costBasis.usdCostBasis = avgCostBasis;
  costBasis.save();
}

export function recognizeTokenSale(
  tokenId: string,
  tokensSold: BigDecimal,
  txnValueUsd: BigDecimal,
  creditorAddress: string,
  isEOA: boolean
): TokenCostBasis | null {
  if (tokensSold.equals(BigDecimal.zero())) {
    return null;
  }

  let costBasis = getOrCreateTokenCostBasis(creditorAddress, tokenId, isEOA);
  let costBasisValue = costBasis.usdCostBasis;
  let tokensAccountedFor = BigDecimal.zero();

  if (tokensSold.le(costBasis.outstandingTokens)) {
    tokensAccountedFor = tokensSold;
    costBasis.outstandingTokens = costBasis.outstandingTokens.minus(tokensSold);
  } else {
    tokensAccountedFor = costBasis.outstandingTokens;
    costBasis.outstandingTokens = BigDecimal.zero();
    costBasis.usdCostBasis = BigDecimal.zero();
    costBasis.unrecognizableTokens = tokensSold.minus(tokensAccountedFor);
  }
  costBasis.consumedTokens = costBasis.consumedTokens.plus(tokensAccountedFor);

  let pricePerToken = txnValueUsd.div(tokensSold);
  if (pricePerToken.gt(costBasisValue)) {
    // recognize profit
    let txnProfit = tokensAccountedFor.times(
      pricePerToken.minus(costBasisValue)
    );
    costBasis.usdTotalProfit = costBasis.usdTotalProfit.plus(txnProfit);
    costBasis.usdTotalNetProceeds = costBasis.usdTotalNetProceeds.plus(
      txnProfit
    );
  } else {
    // recognize loss
    let txnLoss = tokensAccountedFor.times(pricePerToken.minus(costBasisValue));
    costBasis.usdTotalLoss = costBasis.usdTotalLoss.plus(txnLoss);
    costBasis.usdTotalNetProceeds = costBasis.usdTotalNetProceeds.plus(txnLoss);
  }
  costBasis.save();
  return costBasis;
}

export function exponentToBigDecimal(decimals: BigInt): BigDecimal {
  let bd = BigDecimal.fromString('1');
  for (let i = ZERO_BI; i.lt(decimals as BigInt); i = i.plus(ONE_BI)) {
    bd = bd.times(BigDecimal.fromString('10'));
  }
  return bd;
}

export function bigDecimalExp18(): BigDecimal {
  return BigDecimal.fromString('1000000000000000000');
}

export function convertEthToDecimal(eth: BigInt): BigDecimal {
  // @ts-ignore
  return eth.toBigDecimal().div(exponentToBigDecimal(18));
}

export function convertTokenToDecimal(
  tokenAmount: BigInt,
  exchangeDecimals: BigInt
): BigDecimal {
  if (exchangeDecimals == ZERO_BI) {
    return tokenAmount.toBigDecimal();
  }
  return tokenAmount.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals));
}

export function equalToZero(value: BigDecimal): boolean {
  const formattedVal = parseFloat(value.toString());
  const zero = parseFloat(ZERO_BD.toString());
  if (zero == formattedVal) {
    return true;
  }
  return false;
}

export function isNullEthValue(value: string): boolean {
  return (
    value ==
    '0x0000000000000000000000000000000000000000000000000000000000000001'
  );
}

export function fetchTokenSymbol(tokenAddress: Address): string {
  // static definitions overrides
  let staticDefinition = TokenDefinition.fromAddress(tokenAddress);
  if (staticDefinition != null) {
    return staticDefinition.symbol;
  }

  let contract = ERC20.bind(tokenAddress);
  let contractSymbolBytes = ERC20SymbolBytes.bind(tokenAddress);

  // try types string and bytes32 for symbol
  let symbolValue = 'unknown';
  let symbolResult = contract.try_symbol();
  if (symbolResult.reverted) {
    let symbolResultBytes = contractSymbolBytes.try_symbol();
    if (!symbolResultBytes.reverted) {
      // for broken pairs that have no symbol function exposed
      if (!isNullEthValue(symbolResultBytes.value.toHexString())) {
        symbolValue = symbolResultBytes.value.toString();
      }
    }
  } else {
    symbolValue = symbolResult.value;
  }
  return symbolValue;
}

export function fetchTokenName(tokenAddress: Address): string {
  // static definitions overrides
  let staticDefinition = TokenDefinition.fromAddress(tokenAddress);
  if (staticDefinition != null) {
    return (staticDefinition as TokenDefinition).name;
  }

  let contract = ERC20.bind(tokenAddress);
  let contractNameBytes = ERC20NameBytes.bind(tokenAddress);

  // try types string and bytes32 for name
  let nameValue = 'unknown';
  let nameResult = contract.try_name();
  if (nameResult.reverted) {
    let nameResultBytes = contractNameBytes.try_name();
    if (!nameResultBytes.reverted) {
      // for broken exchanges that have no name function exposed
      if (!isNullEthValue(nameResultBytes.value.toHexString())) {
        nameValue = nameResultBytes.value.toString();
      }
    }
  } else {
    nameValue = nameResult.value;
  }

  return nameValue;
}

export function fetchTokenTotalSupply(tokenAddress: Address): BigInt {
  let contract = ERC20.bind(tokenAddress);
  let totalSupplyResult = contract.try_totalSupply();
  if (!totalSupplyResult.reverted) {
    return totalSupplyResult.value;
  } else {
    return ZERO_BI;
  }
}

export function fetchTokenDecimals(tokenAddress: Address): BigInt {
  // static definitions overrides
  let staticDefinition = TokenDefinition.fromAddress(tokenAddress);
  if (staticDefinition != null) {
    return (staticDefinition as TokenDefinition).decimals;
  }

  let contract = ERC20.bind(tokenAddress);
  // try types uint8 for decimals
  // @ts-ignore
  let decimalValue: i32;
  let decimalResult = contract.try_decimals();
  if (!decimalResult.reverted) {
    decimalValue = decimalResult.value;
  }
  // @ts-ignore
  return BigInt.fromI32(decimalValue as i32);
}

export function getOrCreateUser(address: string): User {
  let user = User.load(address);
  if (user === null) {
    user = new User(address);
    user.usdSwapped = ZERO_BD;
    user.save();
  }
  return user;
}
