#!/usr/bin/env node

const http = require('http');
const WebSocket = require('ws');
const WebSocketStream = require('ws-streamify').default;
const args = require('commander');


class ReverserverClient {
  constructor(httpServer) {

    const wss = new WebSocket.Server({ server: httpServer });
    wss.on('connection', (ws) => {

      console.log("New ws connection");

      ws.on('message', (message) => {
        try {
          const parsed = JSON.parse(message);
          this.onMessage(parsed);
        }
        catch(e) {
          console.log(e);
        }
      });

      this._ws = ws;
    });

    this._nextRequestId = 0;

    this._requests = {};

    const streamHandler = (stream, settings) => {

      const id = settings.id;
      const res = this._requests[id];

      res.on('close', () => {
        stream.socket.close();
      });

      if (settings.range) {
        let end;
        if (settings.range.end) {
          end = settings.range.end;
        }
        else {
          end = settings.size - 1;
        }

        const len = end - settings.range.start;
        res.setHeader('Content-Range', `bytes ${settings.range.start}-${end}/${settings.size}`);
        res.setHeader('Content-Length', len + 1);
        res.setHeader('Accept-Ranges', 'bytes');
        res.statusCode = 206;
      }

      res.setHeader('Content-Type', 'application/octet-stream');

      stream.pipe(res);
    };

    const wsHandler = (ws) => {

      const messageHandler = (rawMessage) => {

        const message = JSON.parse(rawMessage.data);

        switch (message.type) {
          case 'convert-to-stream':
            ws.removeListener('message', messageHandler);
            const stream = new WebSocketStream(ws, { highWaterMark: 1024 })
            streamHandler(stream, message);
            break;
          default:
            throw "Invalid message type: " + message.type;
            break;
        }
      };

      ws.addEventListener('message', messageHandler);
    };

    new WebSocket.Server({ port: 8082 }).on('connection', wsHandler);
  }

  getRequestId() {
    const requestId = this._nextRequestId;
    this._nextRequestId++;
    return requestId;
  }

  send(message) {
    this._ws.send(JSON.stringify(message));
  }

  onMessage(message, ws) {

    switch(message.type) {
      case 'error':
        const res = this._requests[message.requestId];
        const e = message;
        console.log("Error:", e);
        res.writeHead(e.code, e.message, {'Content-type':'text/plain'});
        res.end();
        break;
      default:
        throw "Invalid message type: " + message.type
        break;
    }
  }
}


args
  .option('-p, --port [number]', "Server port", 9001)
  .option('-w, --ws-port [port]', "WebSocket port", 8081)
  .parse(process.argv);

const closed = {};

const httpServer = http.createServer(httpHandler).listen(args.port);
const rsClient = new ReverserverClient(httpServer);

function httpHandler(req, res){
  console.log(req.method, req.url, req.headers);
  if (req.method === 'GET') {

    const options = {};

    if (req.headers.range) {

      options.range = {};

      const right = req.headers.range.split('=')[1];
      const range = right.split('-');
      options.range.start = Number(range[0]);

      if (range[1]) {
        options.range.end = Number(range[1]);
      }
      //else {
      //  options.end = stats.size - 1;
      //}

      //const len = options.range.end - options.range.start;
      res.statusCode = 206;
      //res.setHeader('Content-Range', `bytes ${options.range.start}-${options.range.end}/*`);
      //res.setHeader('Content-Range', `bytes ${options.start}-${options.end}/${stats.size}`);
      //res.setHeader('Content-Length', len + 1);
      res.setHeader('Accept-Ranges', 'bytes');
      //res.setHeader('Content-Type', 'application/octet-stream');
    }

    //res.responseCode = 206;
    //res.writeHead(200, {'Content-type':'application/octet-stream'});
    //res.setHeader('Content-type', 'application/octet-stream');

    const requestId = rsClient.getRequestId();

    rsClient.send({
      type: 'GET',
      url: req.url,
      range: options.range,
      requestId,
    });

    rsClient._requests[requestId] = res;
  }
  else {
    res.writeHead(405, {'Content-type':'text/plain'});
    res.write("Method not allowed");
    res.end();
  }
}
