require('dotenv').config()
const http = require('http')
const express	= require('express')
const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')

const app = express()
const port = process.env.PORT || 80

const db = require('./config/db.js')
const books = require('./routes/books')
const movies = require('./routes/movies')
const miam = require('./routes/miam')
const adaptations = require('./routes/adaptations')

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: false }))
app.use(express.static(__dirname + '/public'))

app.all('/books/*', books)
app.all('/movies/*', movies)
app.all('/miam/*', miam)
app.all('/adaptations/*', adaptations)

http.createServer(app).listen(port, function (){
	console.log('Server Started ' + port)
})
