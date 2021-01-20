const _ = require('lodash/fp')

const configManager = require('../new-config-manager')
const logger = require('../logger')
const queries = require('./queries')
const settingsLoader = require('../new-settings-loader')
const customers = require('../customers')

const utils = require('./utils')
const emailFuncs = require('./email')
const smsFuncs = require('./sms')
const codes = require('./codes')
const { STALE, STALE_STATE, PING } = require('./codes')

const { NOTIFICATION_TYPES: {
  HIGH_VALUE_TX,
  NORMAL_VALUE_TX,
  FIAT_BALANCE,
  CRYPTO_BALANCE,
  COMPLIANCE,
  ERROR }
} = codes

function buildMessage (alerts, notifications) {
  const smsEnabled = utils.isActive(notifications.sms)
  const emailEnabled = utils.isActive(notifications.email)

  let rec = {}
  if (smsEnabled) {
    rec = _.set(['sms', 'body'])(
      smsFuncs.printSmsAlerts(alerts, notifications.sms)
    )(rec)
  }
  if (emailEnabled) {
    rec = _.set(['email', 'subject'])(
      emailFuncs.alertSubject(alerts, notifications.email)
    )(rec)
    rec = _.set(['email', 'body'])(
      emailFuncs.printEmailAlerts(alerts, notifications.email)
    )(rec)
  }

  return rec
}

function checkNotification (plugins) {
  const notifications = plugins.getNotificationConfig()
  const smsEnabled = utils.isActive(notifications.sms)
  const emailEnabled = utils.isActive(notifications.email)

  if (!smsEnabled && !emailEnabled) return Promise.resolve()

  return getAlerts(plugins)
    .then(alerts => {
      notifyIfActive('errors', alerts).catch(console.error)
      const currentAlertFingerprint = utils.buildAlertFingerprint(
        alerts,
        notifications
      )
      if (!currentAlertFingerprint) {
        const inAlert = !!utils.getAlertFingerprint()
        // variables for setAlertFingerprint: (fingerprint = null, lastAlertTime = null)
        utils.setAlertFingerprint(null, null)
        if (inAlert) return utils.sendNoAlerts(plugins, smsEnabled, emailEnabled)
      }
      if (utils.shouldNotAlert(currentAlertFingerprint)) return

      const message = buildMessage(alerts, notifications)
      utils.setAlertFingerprint(currentAlertFingerprint, Date.now())
      return plugins.sendMessage(message)
    })
    .then(results => {
      if (results && results.length > 0) {
        logger.debug('Successfully sent alerts')
      }
    })
    .catch(logger.error)
}

function getAlerts (plugins) {
  return Promise.all([
    plugins.checkBalances(),
    queries.machineEvents(),
    plugins.getMachineNames()
  ]).then(([balances, events, devices]) => {
    notifyIfActive('balance', balances).catch(console.error)
    return buildAlerts(checkPings(devices), balances, events, devices)
  })
}

function buildAlerts (pings, balances, events, devices) {
  const alerts = { devices: {}, deviceNames: {} }
  alerts.general = _.filter(r => !r.deviceId, balances)
  _.forEach(device => {
    const deviceId = device.deviceId
    const deviceName = device.name
    const deviceEvents = events.filter(function (eventRow) {
      return eventRow.device_id === deviceId
    })
    const ping = pings[deviceId] || []
    const stuckScreen = checkStuckScreen(deviceEvents, deviceName)

    alerts.devices = _.set([deviceId, 'balanceAlerts'], _.filter(
      ['deviceId', deviceId],
      balances
    ), alerts.devices)
    alerts.devices[deviceId].deviceAlerts = _.isEmpty(ping) ? stuckScreen : ping

    alerts.deviceNames[deviceId] = deviceName
  }, devices)

  return alerts
}

function checkPings (devices) {
  const deviceIds = _.map('deviceId', devices)
  const pings = _.map(utils.checkPing, devices)
  return _.zipObject(deviceIds)(pings)
}

function checkStuckScreen (deviceEvents, machineName) {
  const sortedEvents = _.sortBy(
    utils.getDeviceTime,
    _.map(utils.parseEventNote, deviceEvents)
  )
  const lastEvent = _.last(sortedEvents)

  if (!lastEvent) return []

  const state = lastEvent.note.state
  const isIdle = lastEvent.note.isIdle

  if (isIdle) return []

  const age = Math.floor(lastEvent.age)
  if (age > STALE_STATE) return [{ code: STALE, state, age, machineName }]

  return []
}

function notifCenterTransactionNotify (isHighValue, direction, fiat, fiatCode, deviceId, cryptoAddress) {
  const messageSuffix = isHighValue ? 'High value' : ''
  const message = `${messageSuffix} ${fiat} ${fiatCode} ${direction} transaction`
  const detailB = utils.buildDetail({ deviceId: deviceId, direction, fiat, fiatCode, cryptoAddress })
  return queries.addNotification(isHighValue ? HIGH_VALUE_TX : NORMAL_VALUE_TX, message, detailB)
}

function transactionNotify (tx, rec) {
  return settingsLoader.loadLatest().then(settings => {
    const notifSettings = configManager.getGlobalNotifications(settings.config)
    const highValueTx = tx.fiat.gt(notifSettings.highValueTransaction || Infinity)
    const isCashOut = tx.direction === 'cashOut'

    // for notification center
    const directionDisplay = tx.direction === 'cashOut' ? 'cash-out' : 'cash-in'
    const readyToNotify = tx.direction === 'cashIn' || (tx.direction === 'cashOut' && rec.isRedemption)
    if (readyToNotify) {
      notifyIfActive('transactions', highValueTx, directionDisplay, tx.fiat, tx.fiatCode, tx.deviceId, tx.toAddress).catch(console.error)
    }

    // alert through sms or email any transaction or high value transaction, if SMS || email alerts are enabled
    const cashOutConfig = configManager.getCashOut(tx.deviceId, settings.config)
    const zeroConfLimit = cashOutConfig.zeroConfLimit
    const zeroConf = isCashOut && tx.fiat.lte(zeroConfLimit)
    const notificationsEnabled = notifSettings.sms.transactions || notifSettings.email.transactions
    const customerPromise = tx.customerId ? customers.getById(tx.customerId) : Promise.resolve({})

    if (!notificationsEnabled && !highValueTx) return Promise.resolve()
    if (zeroConf && isCashOut && !rec.isRedemption && !rec.error) return Promise.resolve()
    if (!zeroConf && rec.isRedemption) return sendRedemptionMessage(tx.id, rec.error)

    return Promise.all([
      queries.getMachineName(tx.deviceId),
      customerPromise
    ]).then(([machineName, customer]) => {
      return utils.buildTransactionMessage(tx, rec, highValueTx, machineName, customer)
    }).then(([msg, highValueTx]) => sendTransactionMessage(msg, highValueTx))
  })
}

function sendRedemptionMessage (txId, error) {
  const subject = `Here's an update on transaction ${txId}`
  const body = error
    ? `Error: ${error}`
    : 'It was just dispensed successfully'

  const rec = {
    sms: {
      body: `${subject} - ${body}`
    },
    email: {
      subject,
      body
    }
  }
  return sendTransactionMessage(rec)
}

function sendTransactionMessage (rec, isHighValueTx) {
  return settingsLoader.loadLatest().then(settings => {
    const notifications = configManager.getGlobalNotifications(settings.config)

    const promises = []

    const emailActive =
      notifications.email.active &&
      (notifications.email.transactions || isHighValueTx)
    if (emailActive) promises.push(emailFuncs.sendMessage(settings, rec))

    const smsActive =
      notifications.sms.active &&
      (notifications.sms.transactions || isHighValueTx)
    if (smsActive) promises.push(smsFuncs.sendMessage(settings, rec))

    return Promise.all(promises)
  })
}

const clearOldCryptoNotifications = balances => {
  return queries.getAllValidNotifications(CRYPTO_BALANCE).then(res => {
    const filterByBalance = _.filter(notification => {
      const { cryptoCode, code } = notification.detail
      return !_.find(balance => balance.cryptoCode === cryptoCode && balance.code === code)(balances)
    })
    const indexesToInvalidate = _.compose(_.map('id'), filterByBalance)(res)

    const notInvalidated = _.filter(notification => {
      return !_.find(id => notification.id === id)(indexesToInvalidate)
    }, res)
    return (indexesToInvalidate.length ? queries.batchInvalidate(indexesToInvalidate) : Promise.resolve()).then(() => notInvalidated)
  })
}

const cryptoBalancesNotify = (cryptoWarnings) => {
  return clearOldCryptoNotifications(cryptoWarnings).then(notInvalidated => {
    return cryptoWarnings.forEach(balance => {
      // if notification exists in DB and wasnt invalidated then don't add a duplicate
      if (_.find(o => {
        const { code, cryptoCode } = o.detail
        return code === balance.code && cryptoCode === balance.cryptoCode
      }, notInvalidated)) return

      const fiat = utils.formatCurrency(balance.fiatBalance.balance, balance.fiatCode)
      const message = `${balance.code === 'HIGH_CRYPTO_BALANCE' ? 'High' : 'Low'} balance in ${balance.cryptoCode} [${fiat}]`
      const detailB = utils.buildDetail({ cryptoCode: balance.cryptoCode, code: balance.code })
      return queries.addNotification(CRYPTO_BALANCE, message, detailB)
    })
  })
}

const clearOldFiatNotifications = (balances) => {
  return queries.getAllValidNotifications(FIAT_BALANCE).then(notifications => {
    const filterByBalance = _.filter(notification => {
      const { cassette, deviceId } = notification.detail
      return !_.find(balance => balance.cassette === cassette && balance.deviceId === deviceId)(balances)
    })
    const indexesToInvalidate = _.compose(_.map('id'), filterByBalance)(notifications)
    const notInvalidated = _.filter(notification => {
      return !_.find(id => notification.id === id)(indexesToInvalidate)
    }, notifications)
    return (indexesToInvalidate.length ? queries.batchInvalidate(indexesToInvalidate) : Promise.resolve()).then(() => notInvalidated)
  })
}

const fiatBalancesNotify = (fiatWarnings) => {
  return clearOldFiatNotifications(fiatWarnings).then(notInvalidated => {
    return fiatWarnings.forEach(balance => {
      if (_.find(o => {
        const { cassette, deviceId } = o.detail
        return cassette === balance.cassette && deviceId === balance.deviceId
      }, notInvalidated)) return
      const message = `Cash-out cassette ${balance.cassette} almost empty!`
      const detailB = utils.buildDetail({ deviceId: balance.deviceId, cassette: balance.cassette })
      return queries.addNotification(FIAT_BALANCE, message, detailB)
    })
  })
}

const balancesNotify = (balances) => {
  const cryptoFilter = o => o.code === 'HIGH_CRYPTO_BALANCE' || o.code === 'LOW_CRYPTO_BALANCE'
  const fiatFilter = o => o.code === 'LOW_CASH_OUT'
  const cryptoWarnings = _.filter(cryptoFilter, balances)
  const fiatWarnings = _.filter(fiatFilter, balances)
  return Promise.all([cryptoBalancesNotify(cryptoWarnings), fiatBalancesNotify(fiatWarnings)]).catch(console.error)
}

const clearOldErrorNotifications = alerts => {
  return queries.getAllValidNotifications(ERROR)
    .then(res => {
      // for each valid notification in DB see if it exists in alerts
      // if the notification doesn't exist in alerts, it is not valid anymore
      const filterByAlert = _.filter(notification => {
        const { code, deviceId } = notification.detail
        return !_.find(alert => alert.code === code && alert.deviceId === deviceId)(alerts)
      })
      const indexesToInvalidate = _.compose(_.map('id'), filterByAlert)(res)
      if (!indexesToInvalidate.length) return Promise.resolve()
      return queries.batchInvalidate(indexesToInvalidate)
    })
    .catch(console.error)
}

const errorAlertsNotify = (alertRec) => {
  const embedDeviceId = deviceId => _.assign({ deviceId })
  const mapToAlerts = _.map(it => _.map(embedDeviceId(it), alertRec.devices[it].deviceAlerts))
  const alerts = _.compose(_.flatten, mapToAlerts, _.keys)(alertRec.devices)

  return clearOldErrorNotifications(alerts).then(() => {
    _.forEach(alert => {
      switch (alert.code) {
        case PING: {
          const detailB = utils.buildDetail({ code: PING, age: alert.age ? alert.age : -1, deviceId: alert.deviceId })
          return queries.getValidNotifications(ERROR, _.omit(['age'], detailB)).then(res => {
            if (res.length > 0) return Promise.resolve()
            const message = `Machine down`
            return queries.addNotification(ERROR, message, detailB)
          })
        }
        case STALE: {
          const detailB = utils.buildDetail({ code: STALE, deviceId: alert.deviceId })
          return queries.getValidNotifications(ERROR, detailB).then(res => {
            if (res.length > 0) return Promise.resolve()
            const message = `Machine is stuck on ${alert.state} screen`
            return queries.addNotification(ERROR, message, detailB)
          })
        }
      }
    }, alerts)
  }).catch(console.error)
}

const blacklistNotify = (tx, isAddressReuse) => {
  const code = isAddressReuse ? 'REUSED' : 'BLOCKED'
  const name = isAddressReuse ? 'reused' : 'blacklisted'

  const detailB = utils.buildDetail({ cryptoCode: tx.cryptoCode, code, cryptoAddress: tx.toAddress })
  const message = `Blocked ${name} address: ${tx.cryptoCode} ${tx.toAddress.substr(0, 10)}...`
  return queries.addNotification(COMPLIANCE, message, detailB)
}

const clearBlacklistNotification = (cryptoCode, cryptoAddress) => {
  return queries.clearBlacklistNotification(cryptoCode, cryptoAddress).catch(console.error)
}

const clearOldCustomerSuspendedNotifications = (customerId, deviceId) => {
  const detailB = utils.buildDetail({ code: 'SUSPENDED', customerId, deviceId })
  return queries.invalidateNotification(detailB, 'compliance')
}

const customerComplianceNotify = (customer, deviceId, code, days = null) => {
  // code for now can be "BLOCKED", "SUSPENDED"
  const detailB = utils.buildDetail({ customerId: customer.id, code, deviceId })
  const date = new Date()
  if (days) {
    date.setDate(date.getDate() + days)
  }
  const message = code === 'SUSPENDED' ? `Customer suspended until ${date.toLocaleString()}` : `Customer blocked`

  return clearOldCustomerSuspendedNotifications(customer.id, deviceId)
    .then(() => queries.getValidNotifications(COMPLIANCE, detailB))
    .then(res => {
      if (res.length > 0) return Promise.resolve()
      return queries.addNotification(COMPLIANCE, message, detailB)
    })
    .catch(console.error)
}

const notificationCenterFunctions = {
  'compliance': customerComplianceNotify,
  'balance': balancesNotify,
  'errors': errorAlertsNotify,
  'transactions': notifCenterTransactionNotify
}

// for notification center, check if type of notification is active before calling the respective notify function
const notifyIfActive = (type, ...args) => {
  return settingsLoader.loadLatest().then(settings => {
    const notificationSettings = configManager.getGlobalNotifications(settings.config).notificationCenter
    if (!notificationCenterFunctions[type]) return Promise.reject(new Error(`Notification of type ${type} does not exist`))
    if (!(notificationSettings.active && notificationSettings[type])) return Promise.resolve()
    return notificationCenterFunctions[type](...args)
  })
}

module.exports = {
  transactionNotify,
  checkNotification,
  checkPings,
  checkStuckScreen,
  sendRedemptionMessage,
  blacklistNotify,
  clearBlacklistNotification,
  notifyIfActive
}