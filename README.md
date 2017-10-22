# re-socket

Monkey-patched WebSocket wrapper with support for reconnection and sending keep alive frames.


### Usage
### Constructor
```javascript    
new WebSocketClient(context, url, options)
```
**Options**

| Option | Description |
| ------ | ----------- |
| `name` | Friendly name for the connection (helpful for logging) |
| `timeout` | Timeout in ms to retry. The retry logic will add this value every time it reconnects. |
| `maxRetries` | Number of times to attempt reconnecting quitting. Value can be -1 to try.  |
| `timeoutStrategy` |  A function used to evaluate the duration of the next timeout. <br />Likely options: <br />- additive timeouts (`t => t + t`) or<br />- constant timeouts (`t => t`) |
 | `onmessage` |  |
 | `onerror` |  |
 | `onopen` |  |
 | `onclose` |  |
 | `keepAlive`  |   If enabled, sends a ping frame to the connection at a given interval |
 | `keepAliveTimeout`   |   Interval in ms for sending ping frames<br />   - `keepAliveBody`       Body of the ping frame<br />   - `debug`       Logs all events to the console<br />   - `verbose`     Logs minimal events to the console |

 ```javascript
const ws = new WebSocketClient(
  this,
  `wss://path/to/my/socket`,
  {
    name: 'MyWebSocket',
    onload: this.handleLoad,
    onmessage: this.handleMessage,
    onerror: this.handleError
  }
)
```
