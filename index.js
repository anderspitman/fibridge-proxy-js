#!/usr/bin/env node

const WebSocket = require('ws');
const args = require('commander');
const uuid = require('uuid/v4');
const url = require('url');
import { Multiplexer, encodeObject, decodeObject } from 'omnistreams';
import { UnbufferedWriteStreamAdapter } from 'omnistreams-node-adapter';
//const { WriteStreamAdapter } = require('omnistreams-node-adapter')


class RequestManager {
  constructor(httpServer) {

    const streamHandler = (stream, settings) => {

      const id = settings.id;
      const res = this._responseStreams[id];

      console.log("create stream: ", id)

      if (settings.result.range) {
        let end;
        if (settings.result.range.end) {
          end = settings.result.range.end;
        }
        else {
          end = settings.result.size;
        }

        const len = end - settings.result.range.start;
        // Need to subtract one from end because HTTP ranges are inclusive
        const contentRange = `bytes ${settings.result.range.start}-${end - 1}/${settings.result.size}`;
        console.log(contentRange);
        res.setHeader('Content-Range', contentRange);
        res.setHeader('Content-Length', len);
        res.statusCode = 206;
      }
      else {
        res.setHeader('Content-Length', settings.result.size);
      }

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'application/octet-stream');

      //const consumer = new WriteStreamAdapter({
      //  nodeStream: res, bufferSize: 200
      //})

      const consumer = new UnbufferedWriteStreamAdapter(res)

      stream.pipe(consumer)

      consumer.onFinish(() => {
        console.log("consumer done")
      })
    };


    const streamWsServer = new WebSocket.Server({ noServer: true });

    streamWsServer.on('connection', (ws) => {
      console.log("streamy mux");

      const mux = new Multiplexer()
      console.log(mux);

      mux.setSendHandler((message) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message)
        }
      })

      ws.onmessage = (message) => {
        mux.handleMessage(message.data)
      }

      mux.onControlMessage((rawMessage) => {
        const message = decodeObject(rawMessage)

        if (message.jsonrpc) {
          if (message.error) {
            const res = this._responseStreams[message.id];
            const e = message.error;
            console.log("Error:", e);
            res.writeHead(404, e.message, {'Content-type':'text/plain'});
            res.end();
          }
        }
      })

      mux.onConduit((producer, md) => {
        const metadata = decodeObject(md)
        console.log(metadata)
        streamHandler(producer, metadata);
      })

      const id = uuid();

      console.log("New ws connection: " + id);

      this._muxes[id] = mux;

      mux.sendControlMessage(encodeObject({
        jsonrpc: '2.0',
        method: 'setId',
        params: id,
      }))

      ws.on('close', () => {
        console.log("Remove connection: " + id);
        delete this._muxes[id];
      });
    });

    httpServer.on('upgrade', function upgrade(request, socket, head) {
      const pathname = url.parse(request.url).pathname;

      if (pathname === '/omnistreams') {
        streamWsServer.handleUpgrade(request, socket, head, function done(ws) {
          streamWsServer.emit('connection', ws, request);
        });
      }
    });

    this._muxes = {};

    this._nextRequestId = 0;

    this._responseStreams = {};
  }

  addRequest(id, res, options) {

    const requestId = this.getNextRequestId();

    this.send(id, {
      ...options,
      id: requestId,
    });

    this._responseStreams[requestId] = res;
  }

  getNextRequestId() {
    const requestId = this._nextRequestId;
    this._nextRequestId++;
    return requestId;
  }

  send(id, message) {
    const mux = this._muxes[id]
    if (mux) {
      mux.sendControlMessage(encodeObject(message))
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
    const path = '/' + urlParts.slice(2).join('/');

    const options = {};

    // TODO: parse byte range specs properly according to
    // https://tools.ietf.org/html/rfc7233
    if (req.headers.range) {

      options.range = {};

      const right = req.headers.range.split('=')[1];
      const range = right.split('-');
      options.range.start = Number(range[0]);

      if (range[1]) {
        // Need to add one because HTTP ranges are inclusive
        options.range.end = 1 + Number(range[1]);
      }
    }

    requestManager.addRequest(id, res, {
      jsonrpc: '2.0',
      method: 'getFile',
      params: {
        path,
        range: options.range,
      },
    });

    
  }
  else {
    res.writeHead(405, {'Content-type':'text/plain'});
    res.write("Method not allowed");
    res.end();
  }
}
