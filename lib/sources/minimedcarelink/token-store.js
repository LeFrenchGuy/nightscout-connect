
// MongoDB-backed OAuth token storage for nightscout-connect.
//
// Stores and loads CareLink OAuth tokens in the Nightscout MongoDB database
// so they survive container restarts without requiring file system write access.
//
// Collection: connect_tokens
// Document:   { source: 'minimedcarelink', access_token, refresh_token, client_id, token_url, ... }

var createLogger = require('../../logging');
var log = createLogger();
var oauth = require('./oauth');

var COLLECTION = 'connect_tokens';
var SOURCE_KEY = 'minimedcarelink';

function MongoTokenStore (connectionString) {
  this.connectionString = connectionString;
}

MongoTokenStore.prototype.load = function () {
  var connectionString = this.connectionString;
  var MongoClient;
  try {
    MongoClient = require('mongodb').MongoClient;
  } catch (e) {
    log.warn('[TokenStore] mongodb package not available');
    return Promise.resolve(null);
  }

  var client = new MongoClient(connectionString);
  return client.connect()
    .then(function () {
      return client.db().collection(COLLECTION).findOne({ source: SOURCE_KEY });
    })
    .then(function (doc) {
      return client.close().then(function () {
        if (!doc) {
          log.debug('[TokenStore] No tokens found in MongoDB');
          return null;
        }
        var data = Object.assign({}, doc);
        delete data._id;
        delete data.source;
        if (!oauth.validateLoginData(data)) {
          log.warn('[TokenStore] Token document in MongoDB is missing required fields');
          return null;
        }
        log.debug('[TokenStore] Tokens loaded from MongoDB');
        return data;
      });
    })
    .catch(function (e) {
      log.warn('[TokenStore] Failed to load tokens from MongoDB');
      return client.close().catch(function () { }).then(function () { return null; });
    });
};

MongoTokenStore.prototype.save = function (data) {
  var connectionString = this.connectionString;
  var MongoClient;
  try {
    MongoClient = require('mongodb').MongoClient;
  } catch (e) {
    log.warn('[TokenStore] mongodb package not available, cannot save tokens');
    return Promise.resolve();
  }

  var client = new MongoClient(connectionString);
  var doc = Object.assign({ source: SOURCE_KEY }, data);
  return client.connect()
    .then(function () {
      return client.db().collection(COLLECTION).replaceOne(
        { source: SOURCE_KEY },
        doc,
        { upsert: true }
      );
    })
    .then(function () {
      log.debug('[TokenStore] Tokens saved to MongoDB');
      return client.close();
    })
    .catch(function (e) {
      log.warn('[TokenStore] Failed to save tokens to MongoDB');
      return client.close().catch(function () { });
    });
};

/**
 * Create a MongoDB token store using MONGO_CONNECTION env var.
 * Returns null if MONGO_CONNECTION is not set.
 *
 * @returns {MongoTokenStore|null}
 */
function create () {
  var mongoUri = process.env.MONGO_CONNECTION;
  if (!mongoUri) {
    log.warn('[TokenStore] MONGO_CONNECTION not set, token persistence unavailable');
    return null;
  }
  log.debug('[TokenStore] Using MongoDB for OAuth token storage');
  return new MongoTokenStore(mongoUri);
}

module.exports = { create, MongoTokenStore };
