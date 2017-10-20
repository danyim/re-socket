export const READY_STATE = Object.freeze({
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
})

/**
 * Wrapper for the native WebSocket API; supports reconnections using timeouts
 */
class WebSocketClient {
  /**
   * Constructor
   * @param  {Object} ctx     Context to apply to the socket events
   * @param  {String} url     Websocket URL
   * @param  {Object} options Options for the Websocket. If key isn't provided,
   *                          defaults will be used.
   *
   *      {String}    name        Friendly name for the connection (helpful for
   *                              logging)
   *      {Number}    timeout     Timeout in ms to retry. The retry logic will
   *                              add this value every time it reconnects.
   *      {Number}    maxRetries  Number of times to attempt reconnecting before
   *                              quitting. Value can be -1 to try indefinitely.
   *      {Function}  timeoutStrategy   Function used to evaluate the duration
   *                                    of the next timeout.
   *                                    Likely functions options:
   *                                      - additive timeouts (t => t + t) or
   *                                      - constant timeouts (t => t)
   *      {Function}  onmessage
   *      {Function}  onerror
   *      {Function}  onopen
   *      {Function}  onclose
   *      {Boolean}   keepAlive   If enabled, sends a ping frame to the
   *                              connection at a given interval
   *      {Boolean}   keepAliveTimeout    Interval in ms for sending ping frames
   *      {Boolean}   keepAliveBody       Body of the ping frame
   *      {Boolean}   debug       Logs all events to the console
   *      {Boolean}   verbose     Logs minimal events to the console
   *
   * @return {Object}         WebsocketClient object
   */
  constructor(ctx, url, options = {}) {
    let urlShortName
    try {
      urlShortName = url.substr(url.lastIndexOf('/'))
      if (
        !url ||
        url === '' ||
        !(url.startsWith('ws://') || url.startsWith('wss://'))
      ) {
        throw new Error()
      }
    } catch (e) {
      throw new Error('Invalid Websocket URL provided: ' + url)
    }

    this.options = {
      name: options.name || urlShortName,
      timeout: options.timeout || 5000,
      maxRetries: options.maxRetries || 10,
      timeoutStrategy: options.timeoutStrategy || (time => time),
      onmessage: options.onmessage || (() => {}),
      onerror: options.onerror || (() => {}),
      onopen: options.onopen || (() => {}),
      onclose: options.onclose || (() => {}),
      keepAlive: options.keepAlive || true,
      keepAliveTimeout: options.keepAliveTimeout || 10000,
      keepAliveBody:
        options.keepAliveBody || JSON.stringify({ message: 'Ping!' }),
      debug: options.debug || false,
      verbose: options.verbose || false
    }

    // Validate the keepAliveBody
    if (typeof this.options.keepAliveBody !== 'string') {
      throw new Error('keepAliveBody must be a string')
    }

    this.init(url)
    this.url = url
    this.ctx = ctx

    // Logging flags
    this.debug = this.options.debug
    this.verbose = this.options.verbose

    // Set our default timeout
    this.timeout = this.options.timeout
    this.retries = 0
    this.reconnecting = false
    this.shouldReconnect = true

    // Keep alive handlers
    this.keepAlive = null

    this.init = this.init.bind(this)
    this.open = this.open.bind(this)
    this.close = this.close.bind(this)
    this.message = this.message.bind(this)
    this.error = this.error.bind(this)
    this.send = this.send.bind(this)
  }

  init = (url = null) => {
    // // If we're reconnecting, make an attempt to close the old socket before
    // // reinitializing a new one
    // if (this.reconnecting) {
    //   try {
    //     console.log(
    //       `ws[${this.options.name}]: attempting to close before reconnecting`
    //     )
    //     this.ws.close()
    //   } catch (e) {
    //     console.log('error encountered', e)
    //   }
    // }

    this.ws = new WebSocket(url ? url : this.url)
    this.url = url

    // Wire up the events to the actual WebSocket using the context of
    // WebSocketClient
    this.ws.onopen = this.open.bind(this)
    this.ws.onclose = this.close.bind(this)
    this.ws.onmessage = this.message.bind(this)
    this.ws.onerror = this.error.bind(this)
  }

  /**
   * Handler for the WebSocket's onopen event
   */
  open() {
    if (this.debug) console.log(`ws[${this.options.name}]: open`, arguments)
    if (this.reconnecting) {
      if (this.debug || this.verbose)
        console.log(`ws[${this.options.name}]: connection reestablished!`)
      this.clearReconnections()
    }

    // If the keepAlive option has been enabled, start the ping
    if (this.options.keepAlive) {
      this.queuePing()
    }
    this.options.onopen.apply(this.ctx, arguments)
  }

  /**
   * Handler for the WebSocket's onclose event
   */
  close() {
    if (this.debug || this.verbose)
      console.log(`ws[${this.options.name}]: connection closed`, arguments)

    // Clears any pings from the event loop
    this.stopPing()

    const code = arguments[0] instanceof CloseEvent ? arguments[0].code : null
    // Refer to https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent
    switch (code) {
      // Add additional codes here to whitelist from the retry logic
      case 1000: // CLOSE_NORMAL
      case null: // close() was explicitly & manually called on the WebSocket
        break
      case 1006: // CLOSE_ABNORMAL
      default:
        // If the connection was closed while we're reconnecting, try again with an
        // increased timeout
        if (this.reconnecting) {
          this.retries++
          this.timeout = this.options.timeoutStrategy(this.options.timeout)
        }
        // Reconnect logic here
        if (this.shouldReconnect) this.reconnect()
        break
    }
    this.options.onclose.apply(this.ctx, arguments)
  }

  /**
   * Closes the WebSocket directly
   */
  closeSocket(code, reason) {
    this.clearReconnections()

    // Using the below variable to disable attempts to reconnect when the
    // onclose is eventually called. Ideally, providing a normal close status
    // code (1000) to the close() function should do the trick, but for some
    // reason, it's not propagating the proper status code to the onclose.
    this.shouldReconnect = false
    this.ws.close()
  }

  /**
   * Handler for the WebSocket's onmessage event
   */
  message() {
    if (this.debug) console.log(`ws[${this.options.name}]: message`, arguments)
    this.options.onmessage.apply(this.ctx, arguments)
  }

  /**
   * Handler for the WebSocket's onerror event
   */
  error() {
    const error = arguments[0]

    let readyState = null
    if (error.currentTarget && error.currentTarget.readyState) {
      // Decode the ready state to a human-readable string
      readyState = Object.keys(READY_STATE).filter(
        key => READY_STATE[key] === error.currentTarget.readyState
      )[0]
    }

    // if (this.debug || this.verbose)
    console.log(
      `ws[${this.options.name}]: error, readyState: ${readyState}`,
      error
    )

    this.options.onerror.apply(this.ctx, arguments)
  }

  /**
   * Sends a message through the socket
   * @param  {Object}  data Data to send
   * @param  {Boolean} ping Flag determining whether or not this message is a
   *                        ping event (for debugging purposes)
   */
  send(data, ping = false) {
    // Only log sends for pings when in debug mode; if in verbose, log sends
    // but ignore pings
    if (this.debug) {
      console.log(
        `ws[${this.options.name}]: send${ping ? ' (keep alive)' : ''}`,
        data
      )
    } else if (this.verbose && ping === false) {
      console.log(`ws[${this.options.name}]: send`, data)
    }

    if (this.ws.readyState && this.ws.readyState !== READY_STATE.OPEN) {
      console.log(
        `ws[${this.options
          .name}]: Attempted to send when the WebSocket is closing`
      )
      return
    }

    try {
      this.ws.send(data)
    } catch (e) {
      console.log(`ws[${this.options.name}]: caught an error while sending`, e)
      this.error(e)
    }
  }

  /**
   * Clears all variables tracking reconnections
   */
  clearReconnections = () => {
    this.reconnecting = false
    this.retries = 0
    this.timeout = this.options.timeout
  }

  /**
   * Adds a ping to the event loop
   */
  queuePing = () => {
    const that = this
    this.keepAlive = setInterval(() => {
      that.ping()
    }, this.options.keepAliveTimeout)
  }

  /**
   * Clears the ping from the event loop
   */
  stopPing = () => {
    if (this.keepAlive) {
      clearInterval(this.keepAlive)
    }
  }

  /**
   * Sends a ping message on the socket
   */
  ping = () => {
    // Do not send the ping if the WebSocket is not in the OPEN state
    if (this.ws.readyState !== READY_STATE.OPEN) {
      return
    }

    this.send(this.options.keepAliveBody, null, true)
  }

  /**
   * Attempts to reinitialize the WebSocket connection
   */
  reconnect = () => {
    if (this.retries >= this.options.maxRetries) {
      if (this.debug)
        console.log(
          `ws[${this.options.name}]: max retries reached (${this.options
            .maxRetries}). stopping.`
        )
      this.clearReconnections()
      return
    }
    if (this.debug || this.verbose)
      console.log(
        `ws[${this.options.name}]: next retry ${this.retries + 1}${this.options
          .maxRetries > 0
          ? `/${this.options.maxRetries}`
          : ''} in ${this.timeout}ms`
      )
    this.reconnecting = true

    // Keep the closure
    const that = this
    setTimeout(() => {
      if (that.debug || that.verbose)
        console.log(`ws[${this.options.name}]: reconnecting...`)
      that.init(that.url)
    }, this.timeout)
  }
}

export default WebSocketClient
