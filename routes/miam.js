const router = require('express').Router()
const request = require('request-promise')
const Promise = require('bluebird')
const Miam = require('../config/miam.js')

// retrieve all make it a movie entries from the database
router.get('/miam/all', function (req, res){
    Miam.find({}, function(err, miam) {
        res.send(miam)
    })
})

// get single make it a movie entry by id
router.post('/miam/by-id', function (req, res){
    Miam.find({'goodreads_id':req.body.book_id}, function(err, miam) {
        res.send(miam[0])
    })
})

router.post('/miam/add-new', function(req, res) {
    if (!req.body.goodreads_id) {
        return res.json({
            query: 'no goodreads id',
            result: []
        })
    }

    var new_miam = Miam({
        goodreads_id: req.body.goodreads_id,
        title: req.body.title,
        image_url: req.body.image_url,
        description: req.body.description,
        publication_date: req.body.publication_date,
        average_rating: req.body.average_rating,
        authors: req.body.authors
    })

    new_miam.save(function (err){
      if(err) console.log('new make it a movie save error', err)
      res.sendStatus(200)
    })
})

module.exports = router