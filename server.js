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


app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: false }))

app.all('/books/*', books)
app.all('/movies/*', movies)

http.createServer(app).listen(port, function (){
	console.log('Server Started ' + port)
})
