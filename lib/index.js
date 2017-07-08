

const jPath = require('json-path');
const Queue = require('async-function-queue');
const extend = require('xtend');
const equal = require('deep-equal');

module.exports = createPouchMiddleware;

function createPouchMiddleware(_paths) {
  let paths = _paths || [];
  let loggedIn = false;
  let init = false;

  if (!Array.isArray(paths)) {
    paths = [paths];
  }

  if (!paths.length) {
    throw new Error('PouchMiddleware: no paths');
  }

  const defaultSpec = {
    path: '.',
    remove: scheduleRemove,
    insert: scheduleInsert,
    propagateDelete,
    propagateUpdate,
    propagateInsert,
    handleResponse: function handleResponse(err, data, cb) {
      cb(err);
    },
    queue: Queue(1),
    docs: {},
    actions: {
      remove: defaultAction('remove'),
      update: defaultAction('update'),
      insert: defaultAction('insert')
    }
  };

  paths = paths.map((path) => {
    const spec = extend({}, defaultSpec, path);
    spec.actions = extend({}, defaultSpec.actions, spec.actions);
    spec.docs = {};

    if (!spec.db) {
      throw new Error(`path ${path.path} needs a db`);
    }
    return spec;
  });

  function listen(path, dispatch) {
    console.log('Listen lib');
    dispatch({type: 'init_data_load'});
    const changes = path.db.changes({ include_docs: true, batch_size: 500 });  // ({ live: true, include_docs: true });
    init = true;
    changes.on('change', change => onDbChange(path, change, dispatch, loggedIn)).on('complete', (res) => {
      console.log('Loaded ' + res.results.length + ' docs, starting to LIVE changes listener');
      dispatch({type: 'init_data_load_success'});
      path.db.changes({ live: true, include_docs: true, batch_size: 500 })
      .on('change', change => onDbChange(path, change, dispatch, loggedIn)).on('paused', (err) => {
        console.log('paused');
        if (err) {
          alert(`No connection! ${err}`);
        }
      // replication was paused, usually because of a lost connection
      }).on('error', (err) => {
    // totally unhandled error (shouldn't happen)
      dispatch({type: 'init_data_load_fail'});
      });
    });
    return changes;
  }


  function processNewStateForPath(path, state) {
    const docs = jPath.resolve(state, path.path);

    /* istanbul ignore else */
    if (docs && docs.length) {
      docs.forEach((docs) => {
        const diffs = differences(path.docs, docs);
        diffs.new.concat(diffs.updated).forEach(doc => path.insert(doc));
        diffs.deleted.forEach(doc => path.remove(doc));
      });
    }
  }

  function write(data, responseHandler) {
    return function (done) {
      data.db[data.type](data.doc, (err, resp) => {
        responseHandler(err, {
          response: resp,
          doc: data.doc,
          type: data.type
        }, (err2) => {
          done(err2, resp);
        });
      });
    };
  }

  function scheduleInsert(doc) {
    this.docs[doc._id] = doc;
    this.queue.push(write({
      type: 'put',
      doc,
      db: this.db
    }, this.handleResponse));
  }

  function scheduleRemove(doc) {
    delete this.docs[doc._id];
    this.queue.push(write({
      type: 'remove',
      doc,
      db: this.db
    }, this.handleResponse));
  }

  function propagateDelete(doc, dispatch) {
    dispatch(this.actions.remove(doc));
  }

  function propagateInsert(doc, dispatch) {
    dispatch(this.actions.insert(doc));
  }

  function propagateUpdate(doc, dispatch) {
    dispatch(this.actions.update(doc));
  }

  return function (options) {
    return function (next) {
      return function (action) {
        // start to listen after login event
        // TODO make login not hardcoded
        if (action.type == 'LOGIN') {
          loggedIn = true;
          paths.forEach((path) => {
            listen(path, options.dispatch);
          });
        }
        if (action.type == 'LOGOUT') {
          loggedIn = false;
        }
        if (action.type == 'SESSIONACTIVE') {
          if (!init) {
            loggedIn = true;
            paths.forEach((path) => {
              listen(path, options.dispatch);
            });
          }
        }


        const returnValue = next(action);
        const newState = options.getState();

        paths.forEach(path => processNewStateForPath(path, newState));

        return returnValue;
      };
    };
  };
}

function differences(oldDocs, newDocs) {
  const result = {
    new: [],
    updated: [],
    deleted: Object.keys(oldDocs).map(oldDocId => oldDocs[oldDocId])
  };

  newDocs.forEach((newDoc) => {
    const id = newDoc._id;

    /* istanbul ignore next */
    if (!id) {
      warn('doc with no id');
    }
    result.deleted = result.deleted.filter(doc => doc._id !== id);
    const oldDoc = oldDocs[id];
    if (!oldDoc) {
      result.new.push(newDoc);
    } else if (!equal(oldDoc, newDoc)) {
      result.updated.push(newDoc);
    }
  });

  return result;
}

function onDbChange(path, change, dispatch, loggedIn) {
  const changeDoc = change.doc;

  if (!loggedIn) return;

  if (path.changeFilter && !path.changeFilter(changeDoc)) {
    return;
  }

  if (changeDoc._deleted) {
    if (path.docs[changeDoc._id]) {
      delete path.docs[changeDoc._id];
      path.propagateDelete(changeDoc, dispatch);
    }
  } else {
    const oldDoc = path.docs[changeDoc._id];
    path.docs[changeDoc._id] = changeDoc;
    if (oldDoc) {
      path.propagateUpdate(changeDoc, dispatch);
    } else {
      path.propagateInsert(changeDoc, dispatch);
    }
  }
}

/* istanbul ignore next */
function warn(what) {
  const fn = console.warn || console.log;
  if (fn) {
    fn.call(console, what);
  }
}

/* istanbul ignore next */
function defaultAction(action) {
  return function () {
    throw new Error(`no action provided for ${action}`);
  };
}
