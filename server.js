const bodyParser = require('body-parser');
const ejs = require('ejs');
const express = require('express');
const fs = require('fs');
const im = require('imagemagick');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const ALBUM_DIR = process.env.NODE_GALLERY_DIR || 'example/albums';
const STORAGE_DIR = process.env.NODE_GALLERY_STORAGE_DIR || 'example/data';
const PORT = process.env.NODE_GALLERY_PORT || 8080;
const IP = process.env.NODE_GALLERY_IP || '::1';
const REFRESH_PASSWORD = process.env.REFRESH_PASSWORD || 'password';
const THUMBNAIL_SIZE = 96;
const DISPLAY_SIZE = 640;
const ALBUM_PREVIEW_WIDTH = 288;
const ALBUM_PREVIEW_HEIGHT = 96;

const SECRET = (() => {
  const path = STORAGE_DIR + '/secret';
  try {
    return fs.readFileSync(path, 'utf-8');
  } catch (e) {
    const s = require('crypto').randomBytes(48).toString('hex');

    fs.writeFileSync(path, s);

    return s;
  }
})();

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(session({
  secret: SECRET,
  store: new SQLiteStore({ dir: STORAGE_DIR }),
  resave: false,
  saveUninitialized: false
}));

let albums = {};

function respond(request, response, templateName, locals) {
  const path = __dirname + '/templates/' + templateName + '.html';

  locals.authenticated = !!request.session.passwords;

  ejs.renderFile(path, locals, (err, str) => {
    response.send(str);
  });
}

function directoryExists(path) {
  try { return fs.statSync(path).isDirectory(); }
  catch (e) { return false; }
}

function exists(path) {
  try { return !!fs.statSync(path); }
  catch (e) { return false; }
}

function ensureDirectory(path) {
  if (!directoryExists(path)) fs.mkdir(path, 0755);
}

function formatDate(date) {
  let s = '';
  if (date.getMonth() + 1 < 10) s += '0';
  s += date.getMonth() + '/';
  if (date.getDate() < 10) s += '0';
  s += date.getDate() + '/' + date.getFullYear();
  return s;
}

function getAlbumInfo(name, type) {
  if (albums[name]) return albums[name];

  const info = {
    title: name,
    url: 'album/' + name + '/',
    preview: 'preview/' + name 
  };

  if (type) {
    info.directory = ALBUM_DIR + '/' + type + '/' + name;
    info.type = type;
  } else {
    ['public', 'protected', 'private', 'hidden'].forEach((type) => {
      const candidate = ALBUM_DIR + '/' + type + '/' + name;
      if (directoryExists(candidate)) {
        info.directory = candidate;
        info.type = type;
      }
    });
  }

  if (!info.directory) return null;

  info.created = formatDate(fs.statSync(info.directory).ctime);
  info.createdRaw = fs.statSync(info.directory).ctime.valueOf();

  ensureDirectory(info.directory + '/thumbnails');
  ensureDirectory(info.directory + '/display');
  ensureDirectory(info.directory + '/meta');

  if (info.type == 'protected' || info.type == 'private') {
    const passwordPath = info.directory + '/meta/password';
    if (exists(passwordPath))
      info.password = fs.readFileSync(passwordPath, 'utf8').trim();
  }

  const ignore = new Set(['meta', 'display', 'thumbnails', '.DS_Store']);

  info.photos = fs.readdirSync(info.directory).filter(file => !ignore.has(file));
  console.log('photos', info.photos);

  info.photos.sort((a, b) => {
    if (a > b) return 1;
    else return -1;
  });

  albums[name] = info;

  return info;
}

app.get('/', (request, response) => {
  const locals = {
    albums: []
  };

  ['public', 'protected'].forEach((type) => {
    fs.readdirSync(ALBUM_DIR + '/' + type).forEach((file) => {
      if (file != '.DS_Store')
        locals.albums.push(getAlbumInfo(file, type));
    });
  });

  locals.albums.sort((a, b) => {
    if (a.createdRaw < b.createdRaw) return 1;
    else return -1;
  });

  respond(request, response, 'index', locals);
});

let refreshTimeout = null;
app.get('/refresh', (request, response) => {
  if (refreshTimeout !== null) {
    response.send('wait');
  } else if (request.query.password == REFRESH_PASSWORD) {
    albums = {};
    response.redirect('/');
  } else {
    refreshTimeout = setTimeout(() => {
      response.send('incorrect password');
      refreshTimeout = null;
    }, 1000);
  }
});

function checkAuthentication(request, response, album) {
  if (album.type != 'protected' && album.type != 'private') return true;

  if (request.session.passwords && request.session.passwords[album.title])
    return true;

  response.redirect(
    '/authenticate?album=' + album.title + '&redirect=' + request.url);

  return false;
}

app.get('/forget-passwords', (request, response) => {
  delete request.session.passwords;
  response.redirect('/');
});

app.get('/authenticate', (request, response) => {
  const album = getAlbumInfo(request.query.album);

  const locals = {
    album: album,
    redirect: request.query.redirect,
    wrong: !!request.query.wrong
  };

  respond(request, response, 'authenticate', locals);
});

app.post('/authenticate', (request, response) => {
  const password = request.body.password;
  const album = getAlbumInfo(request.query.album);

  if (album.password == password) {
    if (!request.session.passwords) request.session.passwords = {};
    request.session.passwords[album.title] = password;
    response.redirect(request.query.redirect);
  } else {
    response.redirect(request.url + '&wrong=1');
  }
});

app.get('/album/:album/', (request, response) => {
  const album = getAlbumInfo(request.params.album);

  if (!checkAuthentication(request, response, album)) return;

  const locals = {
    album: album,
  };

  respond(request, response, 'album', locals);
});

app.get('/album/:album/:photo/', (request, response) => {
  const album = getAlbumInfo(request.params.album);

  if (!checkAuthentication(request, response, album)) return;

  const locals = {
    album: album,
    photo: request.params.photo,
    title: request.params.photo.replace(/\.(JPG|jpg|jpeg)/, ''),
    previous: null,
    next: null
  };

  const index = locals.album.photos.indexOf(locals.photo);
  if (index != 0)
    locals.previous = locals.album.photos[index - 1];
  if (index != locals.album.photos.length - 1)
    locals.next = locals.album.photos[index + 1];

  respond(request, response, 'photo', locals);
});

function sendFile(request, response, path) {
  fs.stat(path, (error, stat) => {
    response.setHeader('Content-Length', stat.size);
    response.setHeader('Content-Type', 'image/jpeg');
    response.setHeader(
      'Cache-Control', 'public, max-age=' + (60 * 60 * 24 * 7));
    response.setHeader('Last-Modified', stat.mtime.toUTCString());
    response.setHeader(
      'ETag', '"' + stat.size + '-' + Number(stat.mtime) + '"');

    if (request.method == 'HEAD') return response.end();

    fs.createReadStream(path).pipe(response);
  });
}

const resizes = [];
let resizing = false;
function queueResize(options, callback) {
  console.log('queueing resize: ' + options.dstPath);
  resizes.push({
    options: options,
    callback: callback
  });
  if (!resizing) resize();
}
function resize() {
  resizing = true;
  const entry = resizes.pop();
  console.log('starting resize: ' + entry.options.dstPath);
  im.resize(entry.options, (error, stdout, stderr) => {
    entry.callback(error, stdout, stderr);

    console.log('resized: ' + entry.options.dstPath);
    if (resizes.length) resize();
    else resizing = false;
  });
}

function sendResizedPhoto(request, response, type) {
  const album = getAlbumInfo(request.params.album);

  if (!checkAuthentication(request, response, album)) return;

  let subdir;
  let size;
  let strip;

  if (type == 'thumbnail') {
    subdir = 'thumbnails';
    size = THUMBNAIL_SIZE;
    strip = true;
  } else if (type == 'display') {
    subdir = 'display';
    size = DISPLAY_SIZE;
    strip = false;
  }
  const path = album.directory + '/' + subdir + '/' + request.params.photo;

  if (!exists(path)) {
    queueResize({
      srcPath: album.directory + '/' + request.params.photo,
      dstPath: path,
      width: size,
      height: size,
      strip: strip
    }, (error, stdout, stderr) => {
      if (!error) {
        sendFile(request, response, path);
      }
    });
  } else {
    sendFile(request, response, path);
  }
}

app.get('/album/:album/:photo/original', (request, response) => {
  const album = getAlbumInfo(request.params.album);

  if (!checkAuthentication(request, response, album)) return;

  const path = album.directory + '/' + request.params.photo;
  sendFile(request, response, path);
});

app.get('/album/:album/:photo/display', (request, response) => {
  sendResizedPhoto(request, response, 'display');
});

app.get('/album/:album/:photo/thumbnail', (request, response) => {
  sendResizedPhoto(request, response, 'thumbnail');
});

app.get('/preview/:album', (request, response) => {
  const album = getAlbumInfo(request.params.album);

  // No authentication check here, because we want to show these previews.

  const path = album.directory + '/meta/preview.jpg';

  if (album.photos.length == 0)
    return response.end()

  if (!exists(path)) {
    const imagePath = album.directory + '/' +
      album.photos[Math.floor(Math.random() * album.photos.length)];
    im.resize({
      srcPath: imagePath,
      dstPath: path,
      width: ALBUM_PREVIEW_WIDTH,
      strip: true
    }, (error, stdout, stderr) => {
      im.convert([
        path,
        '-crop',
        ALBUM_PREVIEW_WIDTH + 'x' + ALBUM_PREVIEW_HEIGHT + '+0+0',
        '-gravity',
        'center',
        '+repage',
        path
      ], (error, metadata) => {
        if (!error) sendFile(request, response, path);
        else console.log(error);
      });
      /*
      // Doesn't do its job?
      im.crop({
        srcPath: path,
        dstPath: path,
        width: ALBUM_PREVIEW_WIDTH,
        height: ALBUM_PREVIEW_HEIGHT,
        strip: true
      }, (error, stdout, stderr) => {
        if (!error) sendFile(request, response, path);
      });
      */
    });
  } else {
    sendFile(request, response, path);
  }
});

app.use('/static', express.static(__dirname + '/static'));

app.listen(PORT, IP);
