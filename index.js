'use strict'

/**
 * Module dependencies
 */

const pify = require('promise.ify')
const SequelizeAuto = require('sequelize-auto')
const mysql = require('mysql')
const co = require('co')
const _ = require('lodash')
const debug = require('debug')('waterline-auto:index')

/**
 * patch
 */

pify.all(SequelizeAuto.prototype)
pify.all(require('mysql/lib/Connection').prototype)

const async = co.wrap

/**
 * getTables
 */

const getTables = exports.getTables = async(function*(options) {
  const host = options.host || 'localhost'
  const port = options.port || '3306'
  const database = options.database
  const user = options.user
  const password = options.password
  const tables = options.tables
  const sequelizeLog = Boolean(options.sequelizeLog)

  const auto = new SequelizeAuto(database, user, password, {
    host: host,
    port: port,
    tables: tables,
    logging: sequelizeLog
  })

  yield auto.buildAsync()
  return auto
})

/**
 * getColumns
 */

exports.getColumns = async(function*(options) {
  const host = options.host || 'localhost'
  const port = options.port || '3306'
  const user = options.user
  const password = options.password
  const database = options.database

  const conn = mysql.createConnection({
    host,
    port,
    user,
    password,
    database: 'information_schema',
  })

  const sql = `
    SELECT *
    FROM COLUMNS
    WHERE TABLE_SCHEMA = '${ database }'
  `

  debug('getColumns: \n%s', sql)
  const results = yield conn.queryAsync(sql)
  yield conn.endAsync()
  return results[0]
})

/**
 * transform a table
 */

const transform = exports.transform = async(function*(options) {
  if (!options) throw new Error('table & tableName & dbName cann\'t be empty')
  const rawType = Boolean(options.rawType)
  const comment = Boolean(options.comment)
  const seqAuto = options.seqAuto
  const dbName = options.dbName
  const tableName = options.tableName
  const table = options.table
  const columns = options.columns

  const ret = {
    tableName: tableName
  };

  // autoUpdatedAt / autoCreatedAt
  ['updatedAt', 'createdAt'].forEach(k => {
    if (!table[k]) {
      const key = 'auto' + _.upperFirst(k)
      ret[key] = false
    }
  })

  // attributes
  ret.attributes = {}
  ret._attributes = {}
  for (let columnName in table) {
    const column = table[columnName]
    const key = _.camelCase(columnName)
    const o = ret._attributes[key] = {} // attributes = omit from _attributes

    // columnName
    if (key !== columnName) o.columnName = columnName

    // rawType
    if (rawType) o.rawType = column.type

    // type
    const type = getType(column.type)
    if (Array.isArray(type)) {
      o.type = type[0] && type[0].toLowerCase()
      o.enum = type[1]
    } else {
      o.type = type.toLowerCase()
    }

    // defaults
    if (column.defaultValue) o.defaultsTo = column.defaultValue
    // boolean
    if (o.type === 'boolean' && o.defaultsTo) {
      let m
      if ((m = o.defaultsTo.match(/b?['"]?([01])['"]?/))) {
        o.defaultsTo = m[1] === '1'
      }
    }
    // integer
    if (o.type === 'integer' && typeof o.defaultsTo !== 'undefined') {
      o.defaultsTo = Number(o.defaultsTo)
    }
    // datetime
    if (o.type === 'datetime' &&
      (columnName === 'createdAt' || columnName === 'updatedAt') &&
      o.defaultsTo === 'CURRENT_TIMESTAMP') {
      delete o.defaultsTo
    }

    // primaryKey
    if (column.primaryKey) o.primaryKey = true
    if (o.primaryKey) {
      // decide whether autoIncrement ?
      const item = _.find(columns, {
        TABLE_NAME: tableName,
        COLUMN_KEY: 'PRI'
      })

      const extra = item && item.EXTRA
      const arr = (extra || '').split(',').filter(Boolean)
      if (arr.includes('auto_increment')) {
        o.autoIncrement = true
      }
    }

    // comment
    if (options.comment) {
      const comment = yield getComment({
        seq: seqAuto.sequelize,
        dbName: dbName,
        tableName: tableName,
        columnName: columnName
      })

      if (comment) o.comment = comment
    }

    // 最后 _attributes
    ret.attributes[key] = _.omit(ret._attributes[key], ['comment', 'rawType'])
  }

  // 没有 rawType & comment
  // 就不写 _attributes 了
  if (!options.rawType && !options.comment) {
    delete ret._attributes
  }

  return ret
})

// http://sailsjs.org/documentation/concepts/models-and-orm/attributes
const getType = t => {
  const original = t
  t = t.toLowerCase()

  // boolean
  if (t === 'tinyint(1)' || t === 'boolean' || t === 'bit(1)') return 'boolean'

  // integer
  if (t.match(/^(smallint|mediumint|tinyint|bigint|int)/)) return 'integer'

  // float
  if (t.match(/^float|decimal/)) return 'float'

  // string
  if (t.match(/^string|varchar|varying|nvarchar|char/)) return 'string'

  // text
  if (t.match(/^longtext/)) return 'longtext'
  if (t.match(/^mediumtext/)) return 'mediumtext'
  if (t.match(/text$/)) return 'text'

  // date & time
  if (t === 'datetime') return 'datetime'
  if (t.match(/^date/)) return 'date'
  if (t.match(/^time/)) return '<unsupported type>'

  // json
  if (t.match(/^json/)) return 'json'

  // enum
  if (t.match(/^enum/)) {
    let availables = t.match(/^enum\(((?:[\s\S]+?)(,?[\s\S]+?)*?)\)/)
    availables = availables[1]
    availables = availables.split(/,/).map(_.trim).filter(Boolean)
    availables = availables.map(s => _.trim(s, '\'"'))

    return ['string', availables]
  }

  return '<uknown type>'
}

const getComment = exports.getComment = async(function*(options) {
  options = options || {}
  const seq = options.seq
  const dbName = options.dbName
  const tableName = options.tableName
  const columnName = options.columnName

  const sql = `
  SELECT COLUMN_COMMENT as comment
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=:dbName
    && TABLE_NAME=:tableName
    && COLUMN_NAME=:columnName
  `
  const result = yield seq.query(sql, {
    replacements: {
      dbName: dbName,
      tableName: tableName,
      columnName: columnName
    }
  })

  return result[0] && result[0][0] && result[0][0].comment
})