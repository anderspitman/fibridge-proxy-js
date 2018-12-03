#!/usr/bin/env node

const WebSocket = require('ws');
const WebSocketStream = require('ws-streamify').default;
const args = require('commander');
const uuid = require('uuid/v4');
const { Peer } = require('netstreams');
const url = require('url');


class RequestManager {
  constructor(httpServer) {

    const nsPeer = new Peer();
    
    const streamHandler = (stream, settings) => {

      const id = settings.id;
      const res = this._responseStreams[id];

      res.on('close', () => {
        console.log("closed: " + id);
        stream.terminate();
      //  stream.socket.close();
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
        const contentRange = `bytes ${settings.range.start}-${end}/${settings.size}`;
        console.log(contentRange);
        res.setHeader('Content-Range', contentRange);
        res.setHeader('Content-Length', len + 1);
        res.statusCode = 206;
      }
      else {
        res.setHeader('Content-Length', settings.size);
      }

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'application/octet-stream');

      let idx = 0
      //stream.pipe(res);
      stream.onData((data) => {
        if (idx % 10 === 0) {
          console.log("still receiving")
        }
        idx++
        //console.log(data)
        res.write(new Buffer.from(data));
      });

      stream.onEnd(() => {
        console.log("end stream");
        res.end();
      });
    };


    //const wss = new WebSocket.Server({ server: httpServer });
    const signallingServer = new WebSocket.Server({ noServer: true });
    const streamWsServer = new WebSocket.Server({ noServer: true });

    streamWsServer.on('connection', (ws) => {
      console.log("streamy conn");

      const conn = nsPeer.createConnection();
      console.log(conn);

      conn.setSendHandler((message) => {
        ws.send(message)
      })

      ws.onmessage = (rawMessage) => {
        conn.onMessage(rawMessage)
      }

      conn.onStream((stream, metadata) => {
        console.log("md: ")
        console.log(metadata)

        streamHandler(stream, metadata);
      })
    });

    signallingServer.on('connection', (ws) => {
      const messageHandler = (rawMessage) => {
        const message = JSON.parse(rawMessage);

        switch(message.type) {
          case 'convert-to-stream':
            //ws.removeListener('message', messageHandler);
            //const stream = new WebSocketStream(ws, { highWaterMark: 1024 })
            //streamHandler(stream, message);
            break;
          case 'error':
            const res = this._responseStreams[message.requestId];
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

    httpServer.on('upgrade', function upgrade(request, socket, head) {
      const pathname = url.parse(request.url).pathname;

      if (pathname === '/stream') {
        streamWsServer.handleUpgrade(request, socket, head, function done(ws) {
          streamWsServer.emit('connection', ws, request);
        });
      }
      else {
        signallingServer.handleUpgrade(request, socket, head, function done(ws) {
          signallingServer.emit('connection', ws, request);
        });
      }
    });

    this._cons = {};

    this._nextRequestId = 0;

    this._responseStreams = {};
  }

  addRequest(id, res, options) {

    const requestId = this.getNextRequestId();

    this.send(id, {
      ...options,
      requestId,
    });

    this._responseStreams[requestId] = res;
  }

  getNextRequestId() {
    const requestId = this._nextRequestId;
    this._nextRequestId++;
    return requestId;
  }

  send(id, message) {
    const ws = this._cons[id];
    if (ws) {
      if (ws.readyState == WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
      else {
        console.warn("Attempted to send when readyState = " + ws.readyState);
      }
    }
  }
}


args
  .option('-p, --port [number]', "Server port", 9001)
  .option('--cert [path]', "Certificate file path")
  .option('--key [path]', "Private key file path")
  .parse(process.argv);

const closed = {};

let httpServer;
if (args.cert && args.key) {
  const https = require('https');
  const fs = require('fs');

  const options = {
    key: fs.readFileSync(args.key),
    cert: fs.readFileSync(args.cert)
  };
  httpServer = https.createServer(options, httpHandler)
    .listen(args.port);
}
else {
  const http = require('http');
  httpServer = http.createServer(httpHandler).listen(args.port);
}

const requestManager = new RequestManager(httpServer);

function httpHandler(req, res){
  console.log(req.method, req.url, req.headers);
  if (req.method === 'GET') {

    const urlParts = req.url.split('/');
    const id = urlParts[1];
    const url = '/' + urlParts.slice(2).join('/');

    const options = {};

    // TODO: parse byte range specs properly according to
    // https://tools.ietf.org/html/rfc7233
    if (req.headers.range) {

      options.range = {};

      const right = req.headers.range.split('=')[1];
      const range = right.split('-');
      options.range.start = Number(range[0]);

      if (range[1]) {
        options.range.end = Number(range[1]);
      }
    }

    requestManager.addRequest(id, res, {
      type: 'GET',
      url,
      range: options.range,
    });

    
  }
  else {
    res.writeHead(405, {'Content-type':'text/plain'});
    res.write("Method not allowed");
    res.end();
  }
}
