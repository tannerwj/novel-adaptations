const router = require('express').Router()
const request = require('request-promise')
const Promise = require('bluebird')
const async = require('async-q')
const xml2js = require('xml2js')
const Book = require('../config/book.js')

// retrieve books from the database
router.get('/books/all', function (req, res){
  Book.find({}, function(err, books) {
	res.send(books)
  })
})

// get book by id
router.post('/books/by-id', function (req, res){
	Book.find({'goodreads_id':req.body.book_id}, function(err, books) {
		res.send(books[0])
	})
})

//search good reads for new book
router.post('/books/search-new', function (req, res){
  if(!req.body.query){
	return res.json({
	  query: 'no query',
	  result: []
	})
  }
  var query = req.body.query.replace(/ /g, '+')

  makeRequest({
	path: '/search/index.xml',
	qs: {
	  q: escape(query)
	}
  }).then(parseXml).then(function (data){
	var results = data.GoodreadsResponse.search[0].results[0].work.map(function (result){
	  var book = result.best_book[0]
	  return {
		title: book.title[0],
		goodreads_id: book.id[0]._,
		publication_date: result.original_publication_year[0]._,
		rating: result.average_rating[0],
		author: book.author[0].name[0],
		author_id: book.author[0].id._,
		small_img: book.small_image_url[0]
	  }
	})

	return async.map(results, function (book){
		return Book.findOne({ 'goodreads_id' : book.goodreads_id }).exec().then(function (b){
			if(b) book.exists = true
		})
	}).then(function (){
		var response = {
		  query: data.GoodreadsResponse.search[0].query[0],
		  result: results
		}
		res.json(response)
	})	
  }).catch(function (err){
		res.sendStatus(500)
		console.log('error', err)
  })
})

router.post('/books/add-new', function (req, res){
  if(!req.body.goodreads_id){
	return res.json({
	  query: 'no goodreads id',
	  result: []
	})
  }
  var goodreads_id = req.body.goodreads_id
  //first check if we already have book in db
  makeRequest({
	path: '/book/show',
	qs: {
	  id: escape(goodreads_id)
	}
  }).then(parseXml).then(function (data){
	var book =  data.GoodreadsResponse.book[0]
	//save book in db
	var new_book = Book({
	  goodreads_id: book.id[0],
	  title: book.title[0],
	  original_title: book.work[0].original_title[0],
	  isbn: book.isbn[0],
	  isbn13: book.isbn13[0],
	  image_url: book.image_url[0],
	  small_image_url: book.small_image_url[0],
	  description: book.description[0],
	  publication_date: book.work[0].original_publication_year[0]._,
	  average_rating: book.average_rating[0],
	  authors: book.authors[0].author.map(function (author){
		return {
		  author_id: author.id[0],
		  name: author.name[0],
		  role: author.role[0]
		}
	  })
	})

	//more options to save if wanted:
	//reviews widget, similar books, author images/ratings/links
	//marketplace_id, kindle_asin, original title
	new_book.save(function (err){
	  if(err) console.log('new book save error', err)
	  res.sendStatus(200)
	})

  }).catch(function (err){
	res.sendStatus(500)
	console.log('error', err)
  })
})

function makeRequest (opts){
  var options = {
	uri: 'https://www.goodreads.com',
	qs:{
	  key: process.env.GOODREADS_KEY
	}
  }
  options.uri += opts.path
  for (var attrname in opts.qs){
	options.qs[attrname] = opts.qs[attrname]
  }
  return request(options)
	.then(function (body){
	  return body
	})
	.catch(function (err){
	  return err
	})
}

function parseXml (xml){
  var parser = new xml2js.Parser()
  return new Promise(function (resolve, reject) {
	parser.parseString(xml, function (err, result){
	  if (err){
		return reject(err)
	  }
	  return resolve(result)
	})
  })
}

module.exports = router
