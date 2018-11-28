import { Middleware, MiddlewareCallback, MiddlewareServices, Pipelines } from '../types/middleware'
import { AccountInfo } from '../types/accounts'
import BigNumber from 'bignumber.js'
import { IlpPrepare, Errors, IlpReply, isFulfill } from 'ilp-packet'
import Stats from '../services/stats'
import createLogger from 'ilp-logger'
const log = createLogger('balance-middleware')
const { InsufficientLiquidityError } = Errors

interface BalanceOpts {
  initialBalance?: BigNumber
  minimum?: BigNumber
  maximum?: BigNumber
}

class Balance {
  private balance: BigNumber
  private minimum: BigNumber
  private maximum: BigNumber
  constructor ({
    initialBalance = new BigNumber(0),
    minimum = new BigNumber(0),
    maximum = new BigNumber(Infinity)
  }: BalanceOpts) {
    this.balance = initialBalance
    this.minimum = minimum
    this.maximum = maximum
  }

  add (amount: BigNumber | string | number) {
    const newBalance = this.balance.plus(amount)
    if (newBalance.gt(this.maximum)) {
      log.error('rejected balance update. oldBalance=%s newBalance=%s amount=%s', this.balance, newBalance, amount)
      throw new InsufficientLiquidityError('exceeded maximum balance.')
    }

    this.balance = newBalance
  }

  subtract (amount: BigNumber | string | number) {
    const newBalance = this.balance.minus(amount)
    if (newBalance.lt(this.minimum)) {
      log.error('rejected balance update. oldBalance=%s newBalance=%s amount=%s', this.balance, newBalance, amount)
      throw new Error(`insufficient funds. oldBalance=${this.balance} proposedBalance=${newBalance}`)
    }

    this.balance = newBalance
  }

  getValue () {
    return this.balance
  }

  toJSON () {
    return {
      balance: this.balance.toString(),
      minimum: this.minimum.toString(),
      maximum: this.maximum.toString()
    }
  }
}

export default class BalanceMiddleware implements Middleware {
  private stats: Stats
  private getInfo: (accountId: string) => AccountInfo
  private sendMoney: (amount: string, accountId: string) => Promise<void>
  private balances: Map<string, Balance> = new Map()

  constructor (opts: {}, { getInfo, sendMoney, stats }: MiddlewareServices) {
    this.getInfo = getInfo
    this.sendMoney = sendMoney
    this.stats = stats
  }

  async applyToPipelines (pipelines: Pipelines, accountId: string) {
    const accountInfo = this.getInfo(accountId)
    if (!accountInfo) {
      throw new Error('could not load info for account. accountId=' + accountId)
    }
    const account = { accountId, accountInfo }

    if (accountInfo.balance) {
      const {
        minimum = '-Infinity',
        maximum
      } = accountInfo.balance

      const balance = new Balance({
        minimum: new BigNumber(minimum),
        maximum: new BigNumber(maximum)
      })
      this.balances.set(accountId, balance)

      log.info('initializing balance for account. accountId=%s minimumBalance=%s maximumBalance=%s', accountId, minimum, maximum)

      pipelines.startup.insertLast({
        name: 'balance',
        method: async (dummy: void, next: MiddlewareCallback<void, void>) => {
          // When starting up, check if we need to pre-fund / settle
          // tslint:disable-next-line:no-floating-promises
          this.maybeSettle(accountId)

          this.stats.balance.setValue(account, {}, balance.getValue().toNumber())
          return next(dummy)
        }
      })

      pipelines.incomingData.insertLast({
        name: 'balance',
        method: async (packet: IlpPrepare, next: MiddlewareCallback<IlpPrepare, IlpReply>) => {
          const { amount } = packet
          // Ignore zero amount packets
          if (amount === '0') {
            return next(packet)
          }

          // Increase balance on prepare
          balance.add(amount)
          log.info('balance increased due to incoming ilp prepare. accountId=%s amount=%s newBalance=%s', accountId, amount, balance.getValue())
          this.stats.balance.setValue(account, {}, balance.getValue().toNumber())

          let result
          try {
            result = await next(packet)
          } catch (err) {
            // Refund on error
            balance.subtract(amount)
            log.info('incoming packet refunded due to error. accountId=%s amount=%s newBalance=%s', accountId, amount, balance.getValue())
            this.stats.balance.setValue(account, {}, balance.getValue().toNumber())
            this.stats.incomingDataPacketValue.increment(account, { result : 'failed' }, + amount)
            throw err
          }

          if (isFulfill(result)) {
            this.maybeSettle(accountId).catch(log.error)
            this.stats.incomingDataPacketValue.increment(account, { result : 'fulfilled' }, + amount)
          } else {
            // Refund on reject
            balance.subtract(amount)
            log.info('incoming packet refunded due to ilp reject. accountId=%s amount=%s newBalance=%s', accountId, amount, balance.getValue())
            this.stats.balance.setValue(account, {}, balance.getValue().toNumber())
            this.stats.incomingDataPacketValue.increment(account, { result : 'rejected' }, + amount)
          }

          return result
        }
      })

      pipelines.incomingMoney.insertLast({
        name: 'balance',
        method: (amount: string, next: MiddlewareCallback<string, void>) => {
          balance.subtract(amount)
          log.info('balance reduced due to incoming settlement. accountId=%s amount=%s newBalance=%s', accountId, amount, balance.getValue())
          this.stats.balance.setValue(account, {}, balance.getValue().toNumber())
          return next(amount)
        }
      })

      pipelines.outgoingData.insertLast({
        name: 'balance',
        method: async (packet: IlpPrepare, next: MiddlewareCallback<IlpPrepare, IlpReply>) => {

          const { amount } = packet

          // Ignore zero amount packets
          if (amount === '0') {
            return next(packet)
          }

          // We do nothing here (i.e. unlike for incoming packets) and wait until the packet is fulfilled
          // This means we always take the most conservative view of our balance with the upstream peer
          let result
          try {
            result = await next(packet)
          } catch (err) {
            log.error('outgoing packet not applied due to error. accountId=%s amount=%s newBalance=%s', accountId, amount, balance.getValue())
            this.stats.outgoingDataPacketValue.increment(account, { result : 'failed' }, + amount)
            throw err
          }

          if (isFulfill(result)) {
            // Decrease balance on prepare
            balance.subtract(amount)
            this.maybeSettle(accountId).catch(log.error)
            log.info('balance decreased due to outgoing ilp fulfill. accountId=%s amount=%s newBalance=%s', accountId, amount, balance.getValue())
            this.stats.balance.setValue(account, {}, balance.getValue().toNumber())
            this.stats.outgoingDataPacketValue.increment(account, { result : 'fulfilled' }, + amount)
          } else {
            log.info('outgoing packet not applied due to ilp reject. accountId=%s amount=%s newBalance=%s', accountId, amount, balance.getValue())
            this.stats.outgoingDataPacketValue.increment(account, { result : 'rejected' }, + amount)
          }

          return result
        }
      })

      pipelines.outgoingMoney.insertLast({
        name: 'balance',
        method: (amount: string, next: MiddlewareCallback<string, void>) => {
          balance.add(amount)
          log.info('balance increased due to outgoing settlement. accountId=%s amount=%s newBalance=%s', accountId, amount, balance.getValue())
          this.stats.balance.setValue(account, {}, balance.getValue().toNumber())

          return next(amount)
        }
      })
    } else {
      log.info('(!!!) balance middleware NOT enabled for account, this account can spend UNLIMITED funds. accountId=%s', accountId)
    }
  }

  getStatus () {
    const accounts = {}
    this.balances.forEach((balance, accountId) => {
      accounts[accountId] = balance.toJSON()
    })
    return { accounts }
  }

  private _getBalance (accountId: string): Balance {
    const balance = this.balances.get(accountId)
    if (!balance) {
      throw new Error('account not found. accountId=' + accountId)
    }
    return balance
  }

  modifyBalance (accountId: string, _amountDiff: BigNumber.Value): BigNumber {
    const amountDiff = new BigNumber(_amountDiff)
    const accountInfo = this.getInfo(accountId)
    if (!accountInfo) {
      throw new Error('could not load info for account. accountId=' + accountId)
    }
    const account = { accountId, accountInfo }
    const balance = this._getBalance(accountId)
    log.info('modifying balance accountId=%s amount=%s', accountId, amountDiff.toString())
    if (amountDiff.isPositive()) {
      balance.add(amountDiff)
    } else {
      balance.subtract(amountDiff.negated())
      this.maybeSettle(accountId).catch(log.error)
    }
    this.stats.balance.setValue(account, {}, balance.getValue().toNumber())
    return balance.getValue()
  }

  private async maybeSettle (accountId: string): Promise<void> {
    const accountInfo = this.getInfo(accountId)
    if (!accountInfo) {
      throw new Error('could not load info for account. accountId=' + accountId)
    }
    const account = { accountId, accountInfo }
    const { settleThreshold, settleTo = '0' } = accountInfo.balance!
    const bnSettleThreshold = settleThreshold ? new BigNumber(settleThreshold) : undefined
    const bnSettleTo = new BigNumber(settleTo)
    const balance = this._getBalance(accountId)

    const settle = bnSettleThreshold && bnSettleThreshold.gt(balance.getValue())
    if (!settle) return

    const settleAmount = bnSettleTo.minus(balance.getValue())
    log.info('settlement triggered. accountId=%s balance=%s settleAmount=%s', accountId, balance.getValue(), settleAmount)

    await this.sendMoney(settleAmount.toString(), accountId)
      .catch(e => {
        let err = e
        if (!err || typeof err !== 'object') {
          err = new Error('Non-object thrown: ' + e)
        }
        log.error('error occurred during settlement. accountId=%s settleAmount=%s errInfo=%s', accountId, settleAmount, err.stack ? err.stack : err)
      })
  }
}
