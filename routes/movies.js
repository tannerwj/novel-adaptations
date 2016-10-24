const router = require('express').Router()
const request = require('request-promise')
const Promise = require('bluebird')
const omdb = require('omdb')
const Movie = require('../config/movie.js')

// search omdb for new movie
// http://www.omdbapi.com/?t={Movie+Title}&y={Year}&plot={full-or-short}&r={json-or-xml}
router.post('/movies/search-new', function(req, res) {
    if (!req.body.query) {
        return res.json({
            query: 'no query',
            result: []
        })
    }

    var query = req.body.query.replace(/ /g, '+')

    omdb.search(query, function(err, movies) {
        if (err) {
            console.error(err)
            return res.sendStatus(500)
        }

        var response = {
            query: query,
            result: movies
        }

        res.json(response)
    })
})

// add new movie by imdb id
// http://www.omdbapi.com/?i={imdbID}&plot={full-or-short}&r={json-or-xml}
router.post('/movies/add-new', function(req, res) {
    if (!req.body.imdb_id) {
        return res.json({
            query: 'no imdb id',
            result: []
        })
    }

    var imdb_id = req.body.imdb_id

    omdb.get({ imdb: imdb_id }, true, function(err, movie) {
        if (err) {
            console.error(err)
            return res.sendStatus(500)
        }

        if (!movie) {
            return res.json({
            	query: imdb_id,
            	result: false
            })
        }

        var new_movie = Movie(movie)
        new_movie.save(function (err){
          if(err) console.log('new movie save error', err)
          res.sendStatus(200)
        })
    })
})

module.exports = router
