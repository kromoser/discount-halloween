// An in-memory stand-in for the Apps Script services Code.gs uses, so doGet and
// doPost can run in Node. It copies the Sheets behaviours the backend depends on:
// a leading apostrophe means text, and a leading = would run as a formula.

class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }

  setValues(values) {
    values.forEach((rowValues, r) => {
      rowValues.forEach((v, c) => this.sheet.setCell(this.row + r, this.col + c, v));
    });
    return this;
  }

  setValue(v) {
    this.sheet.setCell(this.row, this.col, v);
    return this;
  }

  setNumberFormat(format) {
    this.sheet.formats.push({ col: this.col, format, numRows: this.numRows });
    return this;
  }

  setDataValidation(rule) {
    this.sheet.validations.push({ col: this.col, rule, numRows: this.numRows });
    return this;
  }

  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r += 1) {
      const line = [];
      for (let c = 0; c < this.numCols; c += 1) {
        const rowValues = this.sheet.rows[this.row - 1 + r] || [];
        const v = rowValues[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.formats = [];
    this.validations = [];
    this.frozenRows = 0;
    this.formulasRun = [];
  }

  store(value) {
    if (typeof value === 'string' && value.startsWith('=')) this.formulasRun.push(value);
    return typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value;
  }

  setCell(row, col, value) {
    while (this.rows.length < row) this.rows.push([]);
    this.rows[row - 1][col - 1] = this.store(value);
  }

  appendRow(values) {
    this.rows.push(values.map((v) => this.store(v)));
  }

  getRange(row, col, numRows, numCols) {
    return new FakeRange(this, row, col, numRows, numCols);
  }

  getDataRange() {
    const width = Math.max(1, ...this.rows.map((r) => r.length));
    return new FakeRange(this, 1, 1, this.rows.length, width);
  }

  getLastRow() { return this.rows.length; }
  getMaxRows() { return 1000; }
  setFrozenRows(n) { this.frozenRows = n; }
}

export function fakeAppsScript({ password = 'correct horse' } = {}) {
  const sheets = new Map();
  const cache = new Map();
  const properties = new Map(password ? [['HOST_PASSWORD', password]] : []);
  const spy = {
    lockTries: [],
    lockBusyTries: 0,
    clockMs: 0,
    lockHeld: false,
    lockReleases: 0,
    flushes: 0,
    errors: [],
    cachePuts: [],
    lockTimesOut: false,
    active: true,
  };
  let uuid = 0;

  const spreadsheet = {
    getId: () => 'sheet-id',
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet: (name) => {
      const sheet = new FakeSheet(name);
      sheets.set(name, sheet);
      return sheet;
    },
  };

  const validationBuilder = () => {
    const rule = {};
    const builder = {
      requireValueInList: (list, dropdown) => { Object.assign(rule, { list, dropdown }); return builder; },
      setAllowInvalid: (allow) => { rule.allowInvalid = allow; return builder; },
      setHelpText: (text) => { rule.helpText = text; return builder; },
      build: () => rule,
    };
    return builder;
  };

  const globals = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => (spy.active ? spreadsheet : null),
      openById: (id) => {
        if (id !== 'sheet-id') throw new Error('bad sheet id ' + id);
        return spreadsheet;
      },
      flush: () => { spy.flushes += 1; },
      newDataValidation: validationBuilder,
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: (ms) => {
          spy.lockTries.push(ms);
          if (spy.lockTimesOut || spy.lockBusyTries > 0) {
            spy.lockBusyTries -= 1;
            spy.clockMs += ms;
            return false;
          }
          spy.lockHeld = true;
          return true;
        },
        releaseLock: () => { spy.lockHeld = false; spy.lockReleases += 1; },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (key) => (cache.has(key) ? cache.get(key) : null),
        put: (key, value, seconds) => {
          if (typeof value !== 'string') throw new TypeError('cache values must be strings');
          spy.cachePuts.push({ key, seconds });
          cache.set(key, value);
        },
        remove: (key) => { cache.delete(key); },
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (properties.has(key) ? properties.get(key) : null),
        setProperty: (key, value) => { properties.set(key, value); },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({
        text,
        setMimeType(mime) { this.mime = mime; return this; },
      }),
    },
    Utilities: {
      getUuid: () => { uuid += 1; return `uuid-${uuid}`; },
      formatDate: (date) => date.toISOString().replace('Z', '-04:00').replace(/\.\d+/, ''),
    },
    Session: { getScriptTimeZone: () => 'America/New_York' },
    // A failed lock attempt moves this clock on, so the 75 s limit doesn't take 75 s to test.
    Date: class extends Date {
      static now() { return Date.now() + spy.clockMs; }
    },
    console: {
      log: () => {},
      error: (...args) => { spy.errors.push(args); },
    },
  };

  return { globals, spy, sheets, cache, properties };
}
