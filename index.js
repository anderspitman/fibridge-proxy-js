#!/usr/bin/env node

const WebSocket = require('ws');
const args = require('commander');
const uuid = require('uuid/v4');
const Busboy = require('busboy');


class HostManager {
  constructor(httpServer) {
    
    const wss = new WebSocket.Server({ server: httpServer });

    wss.on('connection', (ws) => {

      const id = uuid();

      console.log("New ws connection: " + id);

      this._hosts[id] = ws;

      ws.send(JSON.stringify({
        type: 'complete-handshake',
        id,
      }));

      ws.on('close', () => {
        console.log("Remove connection: " + id);
        delete this._hosts[id];
      });
    });

    this._hosts = {};
    this._requests = {};

    this._nextRequestId = 0;
  }

  addRequest(hostId, req, res, options) {

    const requestId = this.getNextRequestId();

    this.send(hostId, {
      ...options,
      requestId,
    });

    this._requests[requestId] = { req, res };

    return requestId;
  }

  getNextRequestId() {
    const requestId = this._nextRequestId;
    this._nextRequestId++;
    return requestId;
  }

  handleFile(file, settings) {

    const { req, res } = this._requests[settings.requestId];

    if (settings.start) {
      let end;
      if (settings.end) {
        end = settings.end;
      }
      else {
        end = settings.fileSize - 1;
      }

      const len = end - settings.start;
      res.setHeader(
        'Content-Range', `bytes ${settings.start}-${end}/${settings.fileSize}`);
      res.setHeader('Content-Length', len + 1);
      res.setHeader('Accept-Ranges', 'bytes');
      res.statusCode = 206;
    }
    else {
      res.setHeader('Content-Length', settings.fileSize);
      res.setHeader('Accept-Ranges', 'bytes');
    }

    res.setHeader('Content-Type', 'application/octet-stream');

    res.setHeader('Content-Length', settings.fileSize);
    file.pipe(res);

    // If the connection closes before the file is finished streaming, this
    // throws away the rest of the file. This is necessary because otherwise
    // busboy never emits the finish event.
    req.connection.addListener('close', function() {
      file.resume();
    });

    // TODO: delete request
  }

  handleCommand(command) {

    const { req, res } = this._requests[command.requestId];

    res.writeHead(command.code, {'Content-type':'text/plain'});
    res.write(command.message);
    res.end();
  }

  send(hostId, message) {
    const ws = this._hosts[hostId];
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

const hostManager = new HostManager(httpServer);


function httpHandler(req, res){
  console.log(req.method, req.url, req.headers);

  // enable CORS 
  res.setHeader("Access-Control-Allow-Origin", "*");
  //res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");

  switch(req.method) {
    case 'GET': {
      
      const urlParts = req.url.split('/');
      const hostId = urlParts[1];
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

      const requestId = hostManager.addRequest(hostId, req, res, {
        type: 'GET',
        url,
        range: options.range,
      });

      break;
    }

    case 'POST': {
      
      if (req.url === '/file') {

        const settings = {};

        const busboy = new Busboy({ headers: req.headers });
        busboy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated, encoding, mimetype) {
          if (fieldname === 'hostId') {
            settings[fieldname] = val;
          }
          else {
            settings[fieldname] = Number(val);
          }
        });
        busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {

          hostManager.handleFile(file, settings);
        });
        busboy.on('finish', function() {
          res.writeHead(200, {'Content-type':'text/plain'});
          res.write("/file OK");
          res.end();
        });
        req.pipe(busboy);
      }
      else if (req.url === '/command') {

        const command = {};

        const busboy = new Busboy({ headers: req.headers });

        busboy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated, encoding, mimetype) {
          command[fieldname] = val;
        });
        busboy.on('finish', function() {

          hostManager.handleCommand(command);

          res.writeHead(200, {'Content-type':'text/plain'});
          res.write("OK");
          res.end();
        });
        req.pipe(busboy);
      }
      break;
    }

    case 'OPTIONS': {

      // handle CORS preflight requests
      res.writeHead(200, {'Content-type':'text/plain'});
      res.write("OK");
      res.end();
      break;
    }

    default: {
      res.writeHead(405, {'Content-type':'text/plain'});
      res.write("Method not allowed");
      res.end();
      break;
    }
  }
}
