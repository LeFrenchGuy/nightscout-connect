
var qs = require('qs');
var url = require('url');
var createLogger = require('../../logging');

var oauth = require('./oauth');
var auth = require('./auth');

var software = require('../../../package.json');
var software_string = [software.name, `${software.name}/${software.version}`, '(OAuth)', software.homepage].join(' ');
var browser_string = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`;
var user_agent_string = browser_string;

// https://github.com/NightscoutFoundation/xDrip/blob/990df119a8404cff56cb68b92a7e0bb640da95ef/app/src/main/java/com/eveningoutpost/dexdrip/cgm/carelinkfollow/client/CareLinkClient.java#L559
// https://github.com/nightscout/minimed-connect-to-nightscout/blob/master/carelink.js
// https://github.com/nightscout/minimed-connect-to-nightscout/blob/master/transform.js

var _known_servers = {
  eu: 'carelink.minimed.eu',
  us: 'carelink.minimed.com'
}

var modDefaults = {
  me_url: '/patient/users/me'
, my_profile_url: '/patient/users/me/profile'
, recent_uploads_url: '/patient/dataUpload/recentUploads'
, monitor_data_url: '/patient/monitor/data'
, config_check_url: '/patient/configuration/system/personal.cp.m2m.enabled'
, patient_list_url: '/patient/m2m/links/patients'
, m2m_data_url: '/patient/m2m/connect/data/gc/patients/'
, country_settings_url: '/patient/countries/settings' // ?countryCode= &language=
, default_language: 'en'
, mime: 'application/json'
};
function base_for (spec) {
  var server = spec.carelinkServer ? spec.carelinkServer : _known_servers[ (spec.carelinkRegion || 'us').toLowerCase( ) ];
  var base = {
    protocol: 'https',
    host: server
  };
  return url.format(base);
}

// --- Data transformation functions (unchanged from original) ---

function sgs_to_sgv (sgs) {
  var datetime = new Date(Date.parse(sgs.datetime));
  var glucose = {
    type: 'sgv'
  , sgv: sgs.sg
  , date: datetime.getTime( )
  , dateString: datetime.toISOString( )
  };

  return glucose;
}

function markers_to_treatment (markers) {
  var meals = markers.filter((entry) => entry.type == 'MEAL');
  var mealIndices = meals.map((meal) => meal.index);

  function find_insulin (meal) {
    return markers.filter((dose) => meal.index == dose.index && dose.type == 'INSULIN').pop( );
  }

  function remaining_non_meal_treatments (candidate) {
    return !mealIndices.includes(candidate.index);

  }

  function make_meal (meal) {
    var dose = find_insulin(meal);
    var treatment = marker.MEAL(meal, dose);
    return treatment;
  }

  function make_remaining (candidate) {
    if (to_fingerprick.types.includes(candidate.type)) {
      return to_fingerprick(candidate);
    }
    return marker.INSULIN(candidate);
  }

  var treatments = meals.map(make_meal);
  var remainder = markers.filter(remaining_non_meal_treatments)
    .map(make_remaining);
  return treatments.concat(remainder);
}

function to_fingerprick (item) {
  return {
    eventType: 'BG CHECK'
    , created_at: item.dateTime
    , glucose: item.value
    , glucoseType: "Finger"
  };
}

to_fingerprick.types = [ 'CALIBRATION', 'BG READING', 'BG' ];
var marker = {
  MEAL: function to_meal (item, dose) {
    var result =  {
      eventType: 'Meal Bolus'
    , created_at: item.dateTime
    , carbs: item.amount || 0
    , _meal: item
    , _dose: dose
    };
    if (dose && dose.bolusType == 'FAST') {
      result.duration = dose.effectiveDuration;
      result.type = 'normal';
      result.insulin = dose.deliveredFastAmount;
      result.programmed = dose.programmedFastAmount;
      if (result.completed) {
        result.unabsorbed = 0;
      }
    }
    return result
  },
  INSULIN: function to_dose (item) {
    var eventType = item.activationType;
    return {
      eventType: 'Correction Bolus'
    , created_at: item.dateTime
    , insulin: item.deliveredFastAmount || 0
    , carelink: item
    };

  }
}

var CARELINK_TREND_TO_NIGHTSCOUT_TREND = {
  'NONE': {
    'trend': 4,
    'direction': 'Flat'
  },
  'UP_TRIPLE': {
    'trend': 1,
    'direction': 'TripleUp'
  },
  'UP_DOUBLE': {
    'trend': 1,
    'direction': 'DoubleUp'
  },
  'UP': {
    'trend': 2,
    'direction': 'SingleUp'
  },
  'DOWN': {
    'trend': 6,
    'direction': 'SingleDown'
  },
  'DOWN_DOUBLE': {
    'trend': 7,
    'direction': 'DoubleDown'
  },
  'DOWN_TRIPLE': {
    'trend': 7,
    'direction': 'TripleDown'
  }
};

function deviceStatusEntry (data, deviceName) {
  const measured = data.lastMedicalDeviceDataUpdateServerTime;
  if (measured === undefined || measured === null || measured === '') return null;
  const measuredAt = new Date(measured);
  if (!Number.isFinite(measuredAt.getTime())) return null;
  var common = {
    'created_at': measuredAt.toISOString(),
    'lastMedicalDeviceDataUpdateServerTime': data['lastMedicalDeviceDataUpdateServerTime'],
    'device': deviceName,
    'uploader': {
      'battery': data.medicalDeviceFamily === 'GUARDIAN'
        ? data.medicalDeviceBatteryLevelPercent
        : (data.conduitBatteryLevel ?? data.medicalDeviceBatteryLevelPercent),
    },
    // For the values these can take, see:
    // https://gist.github.com/mddub/5e4a585508c93249eb51
    'connect': {
      'sensorState': data['sensorState'],
      'calibStatus': data['calibStatus'],
      'sensorDurationHours': data['sensorDurationHours'],
      'timeToNextCalibHours': data['timeToNextCalibHours'],
      'conduitInRange': data['conduitInRange'],
      'conduitMedicalDeviceInRange': data['conduitMedicalDeviceInRange'],
      'conduitSensorInRange': data['conduitSensorInRange'],
      'medicalDeviceBatteryLevelPercent': data['medicalDeviceBatteryLevelPercent'],
      'medicalDeviceFamily': data['medicalDeviceFamily']
    }
  };
  if (data['medicalDeviceFamily'] != 'GUARDIAN') {
    common.pump = {
      'battery': {
        'percent': data['medicalDeviceBatteryLevelPercent'],
      },
      'reservoir': data['reservoirRemainingUnits'],
      'iob': {
        'timestamp': measuredAt.toISOString(),
      },
      'clock': data['sMedicalDeviceTime'],
      // 'clock': timestampAsString(parsePumpTime(data['sMedicalDeviceTime'], offset, offsetMilliseconds, data['medicalDeviceFamily'])),
      // TODO: add last alarm from data['lastAlarm']['code'] and data['lastAlarm']['datetime']
      // https://gist.github.com/mddub/a95dc120d9d1414a433d#file-minimed-connect-codes-js-L79
    };

    if (data.activeInsulin && data.activeInsulin.amount >= 0) {
      common.pump.bolusiob = data.activeInsulin.amount;
      common.pump.iob.bolusiob = data.activeInsulin.amount;
    }
  }
  return common
}

// --- Main driver factory ---
// Authentication uses OAuth Bearer tokens stored in MongoDB.
// Tokens are loaded from and saved to the connect_tokens collection.

var REFRESH_AHEAD_MS = 35 * 60 * 1000;

function carelinkSource (opts, axios, log) {
  log = log || createLogger(opts.debug);

  var baseURL = base_for(opts);
  var default_headers = {
                          'Accept': 'application/json,text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
                          "x-powered-by": software_string,
                          'User-Agent': user_agent_string,
                          'Accept-Language': 'en-US,en;q=0.9',
                          'Accept-Encoding': 'gzip, deflate',
                          'Connection': 'keep-alive',
                        };

  // No cookie jar needed with OAuth - plain axios instance
  var http = axios.create({ baseURL, headers: default_headers });

  // MongoDB-backed token storage and in-memory cache
  var store = require('./token-store').create();
  var _loginData = null;

  var impl = {

    // OAuth authentication: load tokens from MongoDB and refresh if needed.
    // CareLink now requires OAuth2 PKCE — username/password auth is not supported.
    // Run 'nightscout-connect login' once to authenticate and store tokens in MongoDB.
    // Returns auth info with Bearer token for subsequent API calls.
    authFromCredentials (creds, settings) {

      return store.load()
        .then(function (data) {
          if (!data) {
            return Promise.reject(new Error(
              'No OAuth tokens found in MongoDB. '
              + 'Run \'nightscout-connect login\' to authenticate with CareLink.'
            ));
          }

          _loginData = data;

          // Check token expiry and refresh if needed
          if (oauth.isTokenExpired(_loginData.access_token)) {
            log.debug('[OAuth] Access token expired, refreshing before session setup...');
            return oauth.refreshAccessToken(_loginData, axios)
              .then(function (refreshed) {
                _loginData = refreshed;
                store.save(refreshed);
                return {
                  token: refreshed.access_token,
                  loginData: refreshed,
                };
              })
              .catch(function (error) {
                log.error('[OAuth] Token refresh failed during authentication', error);
                return Promise.reject(new Error(
                  'OAuth token refresh failed. Your refresh token may have expired. '
                  + 'Re-run nightscout-connect login to re-authenticate.'
                ));
              });
          }

          log.debug('[OAuth] Access token valid, proceeding with session setup');
          return Promise.resolve({
            token: _loginData.access_token,
            loginData: _loginData,
          });
        });
    },

    // Build session by fetching user info, profile, and country settings.
    // Same logic as original driver but uses OAuth Bearer token instead of
    // cookie-based auth.
    sessionFromAuth(account, settings) {
      var headers = { };
      var authed_headers = {
        Authorization: `Bearer ${account.token}`
      };

      if (account && account.token) {
        headers = authed_headers;
      }
      function getUser ( ) {
        var headers = {
        ...authed_headers
        };
        return http.get(modDefaults.me_url, { headers }).then((resp) => {
          log.debug("[OAuth] User role");
          account.user = resp.data;
          return resp.data;
        }).catch((error) => {
          log.error("[OAuth] Error fetching user", error);
          return Promise.reject(error);
        });
      }

      function getProfile ( ) {
        var headers = {
        ...authed_headers
        };
        return http.get(modDefaults.my_profile_url, { headers }).then((resp) => {
          account.profile = resp.data;
          return resp.data;
        }).catch((error) => {
          log.error("[OAuth] Error fetching profile", error);
        });
      }

      function getCountrySettings ( ) {
        var params = {
          countryCode: opts.countryCode
        , language: opts.languageCode
        };
        var headers = {
        ...authed_headers
        };
        return http.get(modDefaults.country_settings_url, { params, headers }).then((resp) => {
          account.requirements = resp.data;
          return resp.data;
        }).catch((error) => {
          log.error("[OAuth] Error fetching country settings", error);
          return Promise.reject(error);
        });
      }

      function getM2M ( ) {
        var headers = {
        ...authed_headers
        };
        return http.get(modDefaults.config_check_url, { headers }).then((resp) => {
          account.m2m_enabled = resp.data.value;
          return resp.data;
        }).catch((error) => {
          // Non-fatal: M2M config check may not be available
          log.debug("[OAuth] M2M config check unavailable");
          account.m2m_enabled = false;
          return false;
        });
      }

      function fetchPatientList (enabled) {
        if (!enabled) {
          return enabled;
        }
        var acceptable = [null, 'PATIENT', 'PATIENT_US', 'PATIENT_OUS' ];
        if (acceptable.indexOf(account.user.role) > 0) {

          return false;
        }
        var headers = {
        ...authed_headers
        };
        return http.get(modDefaults.patient_list_url, { headers }).then((resp) => {
          log.debug("[OAuth] Linked patients found");
          account.patient_list = resp.data;
          return resp.data;
        }).catch((error) => {
          log.error("[OAuth] Error fetching patient list", error);
        });

      }

      function summarize ( ) {
        var inputs = [getUser( ).then(getM2M).then(fetchPatientList), getProfile( ), getCountrySettings( ) ];
        return Promise.allSettled(inputs).then((results) => {
          var fulfilled = results.filter((result) => 'fulfilled' == result.status);
          if (fulfilled.length < inputs.length) {
            return Promise.reject(new Error("Unable to establish session - check OAuth token and configuration"));
          }
          var isPatient = [ null, 'PATIENT', 'PATIENT_OUS', 'PATIENT_US' ].indexOf(account.user.role) > 0;
          account.isPatient = isPatient;
          if (isPatient) {
            account.patientUsername = account.profile.username;
          } else {
            account.patientUsername = opts.carelinkPatientUsername
              ? opts.carelinkPatientUsername
              : account.patient_list[0].username;
          }
          return account;
        });
      }
      return summarize( );

    },

    // Fetch data using OAuth Bearer token.
    // Tries multiple CareLink endpoints (monitor, M2M, BLE, recent uploads)
    // and returns the first result with sensor glucose readings.
    dataFromSesssion(session, last_known) {
      return impl.refreshIfExpired(session).then(function ( ) {
        return impl.fetchData(session, last_known);
      });
    },

    // The periodic refresh runs on a 30-minute timer that is not aligned with the 3-hour token lifetime
    // (a container restart shifts it), so the token can expire up to 30 minutes before the next check and every
    // request in between fails with HTTP 401. Check right before each fetch and refresh just in time.
    refreshIfExpired (session) {
      if (!session || !session.token || !_loginData || !oauth.isTokenExpired(session.token)) {
        return Promise.resolve( );
      }
      log.debug('[OAuth] Access token expired before fetch, refreshing...');
      return oauth.refreshAccessToken(_loginData, axios).then(function (refreshed) {
        _loginData = refreshed;
        store.save(refreshed);
        session.token = refreshed.access_token;
      }).catch(function (error) {
        log.error('[OAuth] Token refresh before fetch failed', error);
        return Promise.reject(error);
      });
    },

    fetchData(session, last_known) {

      var headers = { };
      var authed_headers = {
        Authorization: `Bearer ${session.token}`
      };
      if (session && session.token) {
        headers = authed_headers;
      }

      function m2m_data ( ) {
        var params = {
          cpSerialNumber: 'NONE'
        , msgType: 'last24hours'
        , requestTime: Date.now( )
        };
        var headers = {
        ...authed_headers
        };
        if (!session.patientUsername) {
          return Promise.resolve(new Error("no patientUsername"));
        }
        return http.get(modDefaults.m2m_data_url + session.patientUsername, { params, headers }).then((resp) => {
          log.debug("[OAuth] M2M data received");
          return resp.data;
        }).catch((error) => {
          log.error("[OAuth] M2M data fetch error", error);
          return Promise.reject(error);
        });
      }

      function bleEndpointData ( ) {
        var body = {
          username: session.profile.username
        , role: "patient"
        };
        var headers = {
        ...authed_headers
        };
        if (!session.isPatient) {
          body.role = "carepartner";
          body.patientId = session.patientUsername;
        }
        return http.post(session.requirements.blePereodicDataEndpoint, body, { headers }).then((resp) => {
          log.debug("[OAuth] BLE endpoint data received");
          return resp.data;
        }).catch((error) => {
          log.error("[OAuth] BLE endpoint error", error);
          return Promise.reject(error);
        });
      }

      function getMonitorData ( ) {
        var headers = {
        ...authed_headers
        };
        return http.get(modDefaults.monitor_data_url, { headers }).then((resp) => {
          log.debug("[OAuth] Monitor data received");
          return resp.data;
        }).catch((error) => {
          log.error("[OAuth] Monitor data error", error);
          return Promise.reject(error);
        });
      }

      function getRecentUploads ( ) {
        var params = {
          numUploads: 1
        };
        var headers = {
        ...authed_headers
        };
        return http.get(modDefaults.recent_uploads_url, { params, headers }).then((resp) => {
          log.debug("[OAuth] Recent uploads received");
          return resp.data;
        }).catch((error) => {
          // The main data request supplies the readings; this one is optional and CareLink answers it with HTTP 405.
          log.debug("[OAuth] Recent uploads error", error);
          return Promise.reject(error);
        });
      }

      function fetch_payload ({ deviceFamily }) {
        log.debug("[OAuth] Selecting data endpoint for device family");
        if (deviceFamily == 'GUARDIAN') {
          return m2m_data( );
        }
        return bleEndpointData( );
      }

      function summarize (results) {
        // return result that has sgs
        var outputs = results
          .filter(({status, value: payload }) => status == 'fulfilled' && payload && payload.sgs)
        ;
        if (outputs.length < 1) {
          return Promise.reject(new Error("Unable to fetch data from any CareLink endpoint"));
        }
        return outputs
          .map((fulfilled) => fulfilled.value)
          .pop( )
        ;
      }

      var inputs = [
        getMonitorData( ).then(fetch_payload)
      , getRecentUploads( )
      ];
      return Promise.allSettled(inputs).then(summarize);
    },

    // OAuth token refresh.
    // Called periodically by the session state machine. Only makes an HTTP
    // request if the JWT access token is actually expired or about to expire.
    refreshSession (authInfo, session) {
      // Refresh well ahead of expiry, in the quiet time between two polls: this check only runs every 30 minutes,
      // so a margin shorter than that would let the token expire between two checks.
      if (!oauth.isTokenExpired(session.token, REFRESH_AHEAD_MS)) {
        return Promise.resolve(session);
      }

      log.debug('[OAuth] Access token expired, refreshing...');
      var loginData = authInfo.loginData || _loginData;
      if (!loginData) {
        return Promise.reject(new Error('No login data available for token refresh'));
      }

      return oauth.refreshAccessToken(loginData, axios)
        .then(function (refreshed) {
          _loginData = refreshed;
          store.save(refreshed);
          // Update token in both session and authInfo for subsequent calls
          session.token = refreshed.access_token;
          authInfo.token = refreshed.access_token;
          authInfo.loginData = refreshed;
          log.debug('[OAuth] Session token refreshed');
          return session;
        })
        .catch(function (error) {
          log.error('[OAuth] Token refresh failed', error);
          return Promise.reject(error);
        });
    },

    // Calculate next fetch time based on 5-minute glucose reading intervals (unchanged)
    align_to_glucose (last_known) {

      if (!last_known || !last_known.entries) {
        return;
      }
      // var last_glucose_at = new Date(last_known.sgvs.mills);
      var last_glucose_at = last_known.entries;
      var missing = ((new Date( )).getTime( ) - last_glucose_at.getTime( )) / (1000 * 60 * 5)
      if (missing > 1 && missing < 3) {
        log.debug("READJUSTING SHOULD MAKE A DIFFERENCE MISSING");

      }
      // A reading that should already be in CareLink has not shown up yet: the poll ran at the usual time
      // (68 s after the reading) and CareLink was a little late. Rather than wait for the next 5-minute slot,
      // which makes the reading 6+ minutes old by the time it arrives, look again shortly. Only for a reading
      // that is overdue by less than OVERDUE_RETRY_WINDOW_MS; a longer gap (sensor warm-up, pump out of range)
      // falls through to the normal schedule so CareLink is not hammered.
      var OVERDUE_RETRY_WINDOW_MS = 4 * 60 * 1000;
      var OVERDUE_RETRY_DELAY_MS = 40 * 1000;
      var overdue_ms = ((new Date( )).getTime( ) - last_glucose_at.getTime( )) - 5 * 60 * 1000;
      if (overdue_ms > 0 && overdue_ms < OVERDUE_RETRY_WINDOW_MS) {
        log.debug("Reading overdue by " + Math.round(overdue_ms / 1000) + " s, retrying soon");
        return (new Date( )).getTime( ) + OVERDUE_RETRY_DELAY_MS + Math.floor(Math.random( ) * 1000 * 8);
      }
      var next_due = last_glucose_at.getTime( ) + (Math.ceil(missing) * 1000 * 60 * 5);
      var buffer_lag = 68000; // 68 second buffer
      var jitter = Math.floor(Math.random( ) * 1000 * 18); // 18 second random
      var align_to = next_due + buffer_lag + jitter;
      return align_to;
    },

    transformPayload (data, last_known) {
      log.debug("CareLink data transformation started");
      if (!data || !data.medicalDeviceFamily) {
        return { entries: [ ] };
      }
      var recent_mills = last_known && last_known.entries ? last_known.entries.getTime( ) : 0;
      var recent_treatment_mills = last_known && last_known.treatments ? last_known.treatments.getTime( ) : 0;
      function is_missing (reading) {
        return reading.date > recent_mills;
      }

      function is_recent_treatment (treatment) {
        // based on glucose
        return (new Date(treatment.created_at)).getTime( ) > recent_treatment_mills;
      }

      function has_dateprop (prop) {
				if (!prop) { prop = 'datetime'; }
        function has_datetime (elem) {
          return elem[prop]
        }
        return has_datetime;
      }

      var deviceName = "nightscout-connect://minimedcarelink/" + data.medicalDeviceFamily;
      var lastConduitDateTime = data.lastConduitDateTime;
      function assign_device (elem) {
        elem.device = deviceName;
        return elem;
      }

      function reassign_zone(field) {
        if (lastConduitDateTime) {
          var zoneOffsetMatch = lastConduitDateTime.match(/[+-]\d{2}:\d{2}$/);
          var zoneOffset = zoneOffsetMatch ? zoneOffsetMatch[0] : '+00:00';
          return adjust_conduit_timezone.bind(null, zoneOffset, field);
        }
        return id;
      }
      
      function id(x) { return x; }

      function adjust_conduit_timezone(zoneOffset, field, item) {
        // Handle item.datetime
				var pattern = /([+-]\d{2}:\d{2}|Z)$/g;
        if (item[field] && item[field].match(pattern)) {
          item[field] = item[field].replace(pattern, zoneOffset);
        }
				return item;
      
      }

      var entries = data.sgs
        .filter(has_dateprop('datetime'))
        .filter(reading => reading.sg !== 0 && (!reading.kind || reading.kind === 'SG'))
        .map(reading => ({...reading}))
        .map(reassign_zone('datetime'))
        .map(sgs_to_sgv)
        .filter(is_missing)
        .map(assign_device);

      // only the last item has its trend described.
      var lastItem = entries[entries.length - 1]
      var lastSGTrend = data.lastSGTrend;
      var trendInfo = CARELINK_TREND_TO_NIGHTSCOUT_TREND[lastSGTrend];
      // guard against pushing a non-reading with only trend information
      if (lastItem && data.lastSG && lastItem.sgv == data.lastSG.sg) {
        lastItem = { lastSGTrend, ...lastItem, ...trendInfo };
        entries[entries.length - 1] = lastItem;
      }

      var deviceStatus = deviceStatusEntry(data, deviceName);
      if (deviceStatus && deviceStatus.pump) {
        var adjust_pump_clock = reassign_zone('clock');
				adjust_pump_clock(deviceStatus.pump);
      }
      const knownStatus = last_known && last_known.devicestatus
        ? new Date(last_known.devicestatus).getTime() : 0;
      var devicestatus = deviceStatus && Date.parse(deviceStatus.created_at) > knownStatus
        ? [deviceStatus] : [];

			var markers = data.markers
        .filter(has_dateprop('dateTime'))
        .map(marker => ({...marker}))
				.map(reassign_zone('dateTime'))
        ;
      var treatments = markers_to_treatment(markers)
        .filter(is_recent_treatment);

      log.debug("CareLink data transformed");
      return { entries, devicestatus, treatments };
    }
  };

  function tracker_for ( ) {
    // var { AxiosHarTracker } = require('axios-har-tracker');
    // var tracker = new AxiosHarTracker(http);
    var AxiosTracer = require('../../trace-axios');
    var tracker = AxiosTracer(http);
    return tracker;
  }

  function generate_driver (builder) {
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize: impl.sessionFromAuth,
      // OAuth token refresh - checks JWT expiry and refreshes via OAuth endpoint
      refresh: impl.refreshSession,
      delays: {
        // Check for token refresh every 30 minutes
        REFRESH_AFTER_SESSSION_DELAY: (1000 * 60 * 30),
        // Force full re-authentication after 4 hours (safety net)
        EXPIRE_SESSION_DELAY: 1000 * 60 * 240,
      }
    });

    builder.register_loop('MinimedCarelink', {
      tracker: tracker_for,
      frame: {
        impl: impl.dataFromSesssion,
        align_schedule: impl.align_to_glucose,
        transform: impl.transformPayload,
        backoff: {
        // wait 2.5 minutes * 2^attempt
          interval_ms: 2.5 * 60 * 1000

        },
        // only try 3 times to get data
        maxRetries: 2
      },
      // expect new data 5 minutes after last success
      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: {
        // wait 2.5 minutes * 2^attempt
        interval_ms: 2.5 * 60 * 1000
      },
    });
    return builder;
  };
  impl.generate_driver = generate_driver;
  return impl;
}

// --- Configuration validation ---
// Validates environment variables and returns driver config.
//
// Required:
//   CONNECT_CARELINK_REGION - 'us' or 'eu'
//   CONNECT_COUNTRY_CODE    - Two-letter country code where CareLink account was created
//
// Optional:
//   CONNECT_CARELINK_SERVER          - Custom server hostname override
//   CONNECT_CARELINK_PATIENT_USERNAME - For care partner accounts, specify which patient
//   CONNECT_LANGUAGE_CODE            - Language code (default: 'en')
//
// OAuth tokens are stored in and loaded from MongoDB (connect_tokens collection).
// Run 'nightscout-connect login' once to generate and store the initial tokens.

carelinkSource.validate = function validate_inputs (input) {

  var ok = false;
  var errors = [ ];

  createLogger(input.debug).debug('MongoDB is used for OAuth token storage');

  var config = {
    carelinkRegion: input.carelinkRegion,
    carelinkServer: input.carelinkServer,
    carelinkPatientUsername: input.carelinkPatientUsername,
    countryCode: input.countryCode,
    languageCode: input.languageCode || 'en',
  };

  if (!config.carelinkRegion) {
    errors.push({desc: "CareLink region is required. Set CONNECT_CARELINK_REGION to 'us' or 'eu'.", err: new Error('CONNECT_CARELINK_REGION') });
  }

  if (!config.countryCode) {
    errors.push({desc: "Country code is required. Set CONNECT_COUNTRY_CODE to the two-letter country code where your CareLink account was created.", err: new Error('CONNECT_COUNTRY_CODE') });
  }

  config.baseURL = base_for(config);
  ok = errors.length == 0;
  config.kind = ok ? 'minimedcarelink' : 'disabled';
  return { ok, errors, config }
}

module.exports = carelinkSource;
