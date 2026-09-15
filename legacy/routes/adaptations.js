const router = require('express').Router()
const request = require('request-promise')
const Promise = require('bluebird')
const async = require('async-q')
const Book = require('../config/book.js')
const Movie = require('../config/movie.js')
const Adaptation = require('../config/adaptation.js')


router.get('/adaptations/all', function (req, res){
	Adaptation.find({}, function(err, adaptations) {
		res.send(adaptations)
	})
})

router.post('/adaptations/by-id', function (req, res){
    Adaptation.find({'_id': req.body.adapt_id}, function(err, adaptations){
        res.send(adaptations[0])
    })
})

router.post('/adaptations/create', function (req, res){
	const book_id = req.body.book_id
	const movie_id = req.body.movie_id

	if(!book_id || !movie_id) return res.sendStatus(404)

	Promise.all([
		Book.find({'goodreads_id': book_id}).exec(),
		Movie.find({'imdbID': movie_id}).exec()
	]).then(function (results){
		const b = results[0][0]
		const m = results[1][0]

		var new_adapt = Adaptation({
			title: m.title,
			description: m.plot,
			year_released: m.year,
			director: m.director,
			writers: m.writer,
			actors: m.actors,
			movie_rating: m.imdbRating,
			movie_image_url: m.poster,
			imdb_id: m.imdbID,
			book_rating: b.average_rating,
			book_image_url: b.image_url,
			book_isbn: b.isbn,
			goodreads_id: b.goodreads_id
		})

		new_adapt.save(function (err, inserted){
			if(err){
				console.log('new book save error', err)
				return res.sendStatus(404)
			}
			res.send(inserted._id)
		})

	}).catch(function (err){
		res.sendStatus(500)
		console.log('error', err)
	})
})

module.exports = router
