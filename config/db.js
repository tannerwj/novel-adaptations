const mongoose = require('mongoose')

mongoose.connect('mongodb://' + process.env.DB_HOST + '/noveladaptations')

var db = mongoose.connection
mongoose.Promise = global.Promise //hack fix

db.on('error', console.error.bind(console, 'DB connection error:'))

db.once('open', console.error.bind(console, 'DB connected'))

var getDB = function (){
  return new Promise(function (resolve, reject){
    if(db) return resolve(db)
    setTimeout(function (){
      resolve(getDB())
    }, 50)
  })
}

module.exports = getDB()
