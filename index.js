#!/usr/bin/env node

const http = require('http');
const WebSocket = require('ws');
const WebSocketStream = require('ws-streamify').default;
const args = require('commander');
const uuid = require('uuid/v4');


class SocketManager {
  constructor(httpServer) {
    
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
      else {
        res.setHeader('Content-Length', settings.size);
        res.setHeader('Accept-Ranges', 'bytes');
      }

      res.setHeader('Content-Type', 'application/octet-stream');

      stream.pipe(res);
    };


    const wss = new WebSocket.Server({ server: httpServer });

    wss.on('connection', (ws) => {
      const messageHandler = (rawMessage) => {
        const message = JSON.parse(rawMessage);

        switch(message.type) {
          case 'convert-to-stream':
            ws.removeListener('message', messageHandler);
            const stream = new WebSocketStream(ws, { highWaterMark: 1024 })
            streamHandler(stream, message);
            break;
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
      };

      const id = uuid();

      console.log("New ws connection: " + id);

      this._cons[id] = ws;

      ws.send(JSON.stringify({
        type: 'complete-handshake',
        id,
      }));

      ws.on('message', messageHandler);

      ws.on('close', () => {
        console.log("Remove connection: " + id);
        delete this._cons[id];
      });
    });

    this._cons = {};

    this._nextRequestId = 0;

    this._requests = {};
  }

  getRequestId() {
    const requestId = this._nextRequestId;
    this._nextRequestId++;
    return requestId;
  }

  send(id, message) {
    const ws = this._cons[id];
    ws.send(JSON.stringify(message));
  }
}


args
  .option('-p, --port [number]', "Server port", 9001)
  .parse(process.argv);

const closed = {};

const httpServer = http.createServer(httpHandler).listen(args.port);
const rsClient = new SocketManager(httpServer);

function httpHandler(req, res){
  console.log(req.method, req.url, req.headers);
  if (req.method === 'GET') {

    const urlParts = req.url.split('/');
    const id = urlParts[1];
    const url = '/' + urlParts.slice(2).join('/');

    const options = {};

    if (req.headers.range) {

      options.range = {};

      const right = req.headers.range.split('=')[1];
      const range = right.split('-');
      options.range.start = Number(range[0]);

      if (range[1]) {
        options.range.end = Number(range[1]);
      }
    }

    const requestId = rsClient.getRequestId();

    rsClient.send(id, {
      type: 'GET',
      url,
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
