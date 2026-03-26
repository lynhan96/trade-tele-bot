import { Model, Types } from 'mongoose';
import { OrderDocument } from '../schemas/order.schema';

/** Order types that represent the main position (includes promoted hedge after FLIP). */
const MAIN_TYPES = ['MAIN', 'FLIP_MAIN'];

/** Query filter for main order types */
export const MAIN_ORDER_TYPES = { $in: MAIN_TYPES };

/**
 * Order-based state helpers — single source of truth for trading state.
 * These functions query the orders collection instead of reading signal fields.
 */
export class OrderHelpers {
  constructor(private readonly orderModel: Model<OrderDocument>) {}

  /** Get the currently open HEDGE order (null if no hedge active). */
  async getActiveHedge(signalId: Types.ObjectId | string): Promise<OrderDocument | null> {
    return this.orderModel.findOne({ signalId, type: 'HEDGE', status: 'OPEN' });
  }

  /** Get the current trading direction from OPEN main orders. */
  async getActiveDirection(signalId: Types.ObjectId | string): Promise<string | null> {
    const main = await this.orderModel.findOne({
      signalId, type: MAIN_ORDER_TYPES, status: 'OPEN',
    }).select('direction').lean();
    return (main as any)?.direction ?? null;
  }

  /** Get weighted average entry and total notional from OPEN main orders. */
  async getMainOrderState(signalId: Types.ObjectId | string): Promise<{
    orders: OrderDocument[];
    avgEntry: number;
    totalNotional: number;
    direction: string | null;
  }> {
    const orders = await this.orderModel.find({
      signalId, type: MAIN_ORDER_TYPES, status: 'OPEN',
    });
    if (!orders.length) return { orders: [], avgEntry: 0, totalNotional: 0, direction: null };
    const totalNotional = orders.reduce((s, o) => s + o.notional, 0);
    const avgEntry = orders.reduce((s, o) => s + o.entryPrice * o.notional, 0) / totalNotional;
    return { orders, avgEntry, totalNotional, direction: orders[0].direction };
  }

  /** Get total filled volume from OPEN main orders. */
  async getFilledVolume(signalId: Types.ObjectId | string): Promise<number> {
    const result = await this.orderModel.aggregate([
      { $match: { signalId: new Types.ObjectId(signalId as string), type: { $in: MAIN_TYPES }, status: 'OPEN' } },
      { $group: { _id: null, total: { $sum: '$notional' } } },
    ]);
    return result[0]?.total || 0;
  }

  /** Get banked profit from CLOSED HEDGE orders (optionally filtered by date). */
  async getBankedProfit(signalId: Types.ObjectId | string, afterDate?: Date): Promise<number> {
    const query: any = { signalId, type: 'HEDGE', status: 'CLOSED' };
    if (afterDate) query.closedAt = { $gt: afterDate };
    const orders = await this.orderModel.find(query).select('pnlUsdt').lean();
    return (orders as any[]).reduce((s, o) => s + (o.pnlUsdt || 0), 0);
  }

  /** Get all orders for a signal (for admin panel display). */
  async getSignalOrders(signalId: Types.ObjectId | string): Promise<OrderDocument[]> {
    return this.orderModel.find({ signalId }).sort({ openedAt: -1 });
  }

  /** Get order summary stats for a signal. */
  async getOrderSummary(signalId: Types.ObjectId | string): Promise<{
    openMainCount: number;
    openHedgeCount: number;
    closedCount: number;
    totalPnlUsdt: number;
    totalFees: number;
  }> {
    const orders = await this.orderModel.find({ signalId }).lean() as any[];
    const open = orders.filter(o => o.status === 'OPEN');
    const closed = orders.filter(o => o.status === 'CLOSED');
    return {
      openMainCount: open.filter(o => MAIN_TYPES.includes(o.type)).length,
      openHedgeCount: open.filter(o => o.type === 'HEDGE').length,
      closedCount: closed.length,
      totalPnlUsdt: closed.reduce((s: number, o: any) => s + (o.pnlUsdt || 0), 0),
      totalFees: orders.reduce((s: number, o: any) =>
        s + (o.entryFeeUsdt || 0) + (o.exitFeeUsdt || 0) + (o.fundingFeeUsdt || 0), 0),
    };
  }
}
