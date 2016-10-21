const router = require('express').Router()
const request = require('request-promise')
const Promise = require('bluebird')
const omdb = require('omdb')
const mongodb = require('mongodb')

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

        insertMovie(movie)
        res.json(movie)
    })
})

function insertMovie(to_insert) {
    // we need to work with "MongoClient" interface in order to connect to a mongodb server.
    var MongoClient = mongodb.MongoClient

    // connection URL. This is where your mongodb server is running.
    var url = 'mongodb://localhost:27017/noveladaptations'

    // use connect method to connect to the Server
    MongoClient.connect(url, function(err, db) {
        if (err) {
            console.log('Unable to connect to the mongoDB server. Error:', err)
        } else {
            // HURRAY!! We are connected. :)
            console.log('Connection established to', url)

			// get the documents collection
			var collection = db.collection('movies')

			// insert the movie
			collection.insert([to_insert], function (err, result) {
				if (err) {
					console.log(err)
				} else {
					console.log('Inserted %d documents into the "movies" collection. The documents inserted with "_id" are:', result.length, result)
				}

	            // close connection
	            db.close()
        	})
		}
    })
}

module.exports = router