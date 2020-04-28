import { strict as assert } from 'assert';
import { Market, MarketType } from 'crypto-markets';
import { ChannelType } from '../pojo/channel_type';
import { BboMsg, KlineMsg, OrderBookMsg, OrderItem, TradeMsg } from '../pojo/msg';
import { defaultMsgCallback, MsgCallback } from './index';
import { connect, debug, getChannels, initBeforeCrawl } from './util';

const EXCHANGE_NAME = 'Binance';

const PERIOD_NAMES: { [key: string]: string } = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '2h': '2H',
  '4h': '4H',
  '6h': '6H',
  '8h': '8H',
  '12h': '12H',
  '1d': '1D',
  '3d': '3D',
  '1w': '1W',
  '1M': '1M',
};

const WEBSOCKET_ENDPOINTS: { [key: string]: string } = {
  Spot: 'wss://stream.binance.com:9443',
  Swap: 'wss://fstream.binance.com',
};

function getChannel(
  marketType: MarketType,
  channeltype: ChannelType,
  pair: string,
  markets: readonly Market[],
): readonly string[] {
  const market = markets.filter((x) => x.pair === pair && x.type === marketType)[0];
  assert.ok(market, `${EXCHANGE_NAME} ${marketType} market does NOT have ${pair}`);
  assert.equal(market.exchange, EXCHANGE_NAME);

  const rawPair = market.id.toLowerCase();
  switch (channeltype) {
    case 'BBO':
      return [`${rawPair}@bookTicker`];
    case 'Kline':
      return Object.keys(PERIOD_NAMES).map((x) => `${rawPair}@kline_${x}`);
    case 'OrderBook':
      return [`${rawPair}@depth`];
    case 'Trade':
      return [`${rawPair}@aggTrade`]; // trade or aggTrade
    default:
      throw Error(`ChannelType ${channeltype} is not supported for ${EXCHANGE_NAME} yet`);
  }
}

function getChannelType(channel: string): ChannelType {
  assert.ok(channel.includes('@'));
  const suffix = channel.split('@')[1];

  if (suffix.startsWith('kline_')) return 'Kline';

  let result: ChannelType;
  switch (suffix) {
    case 'bookTicker':
      result = 'BBO';
      break;
    case 'depth':
      result = 'OrderBook';
      break;
    // case 'kline_1m':
    //   result = 'Kline';
    //   break;
    case 'trade':
      result = 'Trade';
      break;
    case 'aggTrade':
      result = 'Trade';
      break;
    default:
      throw Error(`Unknown channel: ${channel}`);
  }
  return result;
}

export default async function crawl(
  marketType: MarketType,
  channelTypes: readonly ChannelType[],
  pairs: readonly string[],
  msgCallback: MsgCallback = defaultMsgCallback,
): Promise<void> {
  assert.ok(['Spot', 'Swap'].includes(marketType), 'Binance has only Spot and Swap markets');

  const [markets, marketMap] = await initBeforeCrawl(EXCHANGE_NAME, pairs, marketType);

  const channels = getChannels(marketType, channelTypes, pairs, markets, getChannel);
  assert.ok(channels.length > 0);
  if (!channelTypes.includes('Kline')) {
    assert.equal(channels.length, channelTypes.length * pairs.length);
  }

  const websocketUrl = `${WEBSOCKET_ENDPOINTS[marketType]}/stream?streams=${channels.join('/')}`;

  connect(
    websocketUrl,
    async (data) => {
      const raw = data as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawMsg: { stream: string; data: { [key: string]: any } } = JSON.parse(raw);
      const channelType = getChannelType(rawMsg.stream);

      switch (channelType) {
        case 'BBO': {
          const rawBookTickerMsg = rawMsg.data as {
            u: number; // order book updateId
            s: string; // symbol
            b: string; // best bid price
            B: string; // best bid qty
            a: string; // best ask price
            A: string; // best ask qty
          };
          const msg: BboMsg = {
            exchange: EXCHANGE_NAME,
            marketType,
            pair: marketMap.get(rawBookTickerMsg.s)!.pair,
            rawPair: rawBookTickerMsg.s,
            channel: rawMsg.stream,
            channelType,
            timestamp: Date.now(),
            raw: rawMsg,
            bidPrice: parseFloat(rawBookTickerMsg.b),
            bidQuantity: parseFloat(rawBookTickerMsg.B),
            askPrice: parseFloat(rawBookTickerMsg.a),
            askQuantity: parseFloat(rawBookTickerMsg.A),
          };

          msgCallback(msg);
          break;
        }
        case 'OrderBook': {
          const rawOrderbookMsg = rawMsg.data as {
            e: string;
            E: number;
            s: string;
            U: number;
            u: number;
            b: Array<Array<string>>;
            a: Array<Array<string>>;
          };
          assert.equal(rawOrderbookMsg.e, 'depthUpdate');
          const msg: OrderBookMsg = {
            exchange: EXCHANGE_NAME,
            marketType,
            pair: marketMap.get(rawOrderbookMsg.s)!.pair,
            rawPair: rawOrderbookMsg.s,
            channel: rawMsg.stream,
            channelType,
            timestamp: rawOrderbookMsg.E,
            raw: rawMsg,
            asks: [],
            bids: [],
            full: false,
          };
          const parseOrder = (arr: Array<string>): OrderItem => {
            assert.equal(arr.length, 2);
            const orderItem: OrderItem = {
              price: parseFloat(arr[0]),
              quantity: parseFloat(arr[1]),
              cost: 0,
            };
            orderItem.cost = orderItem.price * orderItem.quantity;
            return orderItem;
          };
          msg.asks = rawOrderbookMsg.a.map((text: Array<string>) => parseOrder(text));
          msg.bids = rawOrderbookMsg.b.map((text: Array<string>) => parseOrder(text));

          msgCallback(msg);
          break;
        }
        case 'Kline': {
          const rawKlineMsg = rawMsg.data as {
            e: string; // Event type
            E: number; // Event time
            s: string; // Symbol
            k: {
              t: number; // Kline start time
              T: number; // Kline close time
              s: string; // Symbol
              i: string; // Interval
              f: number; // First trade ID
              L: number; // Last trade ID
              o: string; // Open price
              c: string; // Close price
              h: string; // High price
              l: string; // Low price
              v: string; // Base asset volume
              n: number; // Number of trades
              x: boolean; // Is this kline closed?
              q: string; // Quote asset volume
              V: string; // Taker buy base asset volume
              Q: string; // Taker buy quote asset volume
              B: string; // Ignore
            };
          };

          const klineMsg: KlineMsg = {
            exchange: EXCHANGE_NAME,
            marketType,
            pair: marketMap.get(rawKlineMsg.s)!.pair,
            rawPair: rawKlineMsg.s,
            channel: rawMsg.stream,
            channelType,
            timestamp: rawKlineMsg.k.t,
            raw: rawKlineMsg,
            open: parseFloat(rawKlineMsg.k.o),
            high: parseFloat(rawKlineMsg.k.h),
            low: parseFloat(rawKlineMsg.k.l),
            close: parseFloat(rawKlineMsg.k.c),
            volume: parseFloat(rawKlineMsg.k.v),
            quoteVolume: parseFloat(rawKlineMsg.k.q),
            period: PERIOD_NAMES[rawKlineMsg.k.i],
          };

          msgCallback(klineMsg);
          break;
        }
        case 'Trade': {
          if (rawMsg.stream.split('@')[1] === 'trade') {
            const rawTradeMsg = rawMsg.data as {
              e: string;
              E: number;
              s: string;
              t: number;
              p: string;
              q: string;
              b: number;
              a: number;
              T: number;
              m: boolean;
              M: boolean;
            };
            assert.equal(rawTradeMsg.e, 'trade');
            const msg: TradeMsg = {
              exchange: EXCHANGE_NAME,
              marketType,
              pair: marketMap.get(rawTradeMsg.s)!.pair,
              rawPair: rawTradeMsg.s,
              channel: rawMsg.stream,
              channelType,
              timestamp: rawTradeMsg.T,
              raw: rawMsg,
              price: parseFloat(rawTradeMsg.p),
              quantity: parseFloat(rawTradeMsg.q),
              side: rawTradeMsg.m === false,
              trade_id: rawTradeMsg.t.toString(),
            };

            msgCallback(msg);
          } else {
            const rawTradeMsg = rawMsg.data as {
              e: string; // Event type
              E: number; // Event time
              s: string; // Symbol
              a: number; // Aggregate trade ID
              p: string; // Price
              q: string; // Quantity
              f: number; // First trade ID
              l: number; // Last trade ID
              T: number; // Trade time
              m: boolean; // Is the buyer the market maker?
              M: boolean; // Ignore
            };
            assert.equal(rawTradeMsg.e, 'aggTrade');
            const msg: TradeMsg = {
              exchange: EXCHANGE_NAME,
              marketType,
              pair: marketMap.get(rawTradeMsg.s)!.pair,
              rawPair: rawTradeMsg.s,
              channel: rawMsg.stream,
              channelType,
              timestamp: rawTradeMsg.T,
              raw: rawMsg,
              price: parseFloat(rawTradeMsg.p),
              quantity: parseFloat(rawTradeMsg.q),
              side: rawTradeMsg.m === false,
              trade_id: rawTradeMsg.a.toString(),
            };

            msgCallback(msg);
          }

          break;
        }
        default:
          debug(`Unrecognized CrawlType: ${channelType}`);
          debug(rawMsg);
      }
    },
    undefined,
  );
}
