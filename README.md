# re-socket

Monkey-patched WebSocket wrapper with support for reconnection and keep alive frames.


### Usage
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
