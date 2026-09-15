const mongoose = require('mongoose')
const Schema = mongoose.Schema

const MiamSchema = new Schema({
  goodreads_id: { type: Number, unique: true },
  title: String,
  image_url: String,
  description: String,
  publication_date: String,
  average_rating: String,
  authors: [{
    name:  String,
    role: String
  }],
  essential_movie_parts: [{
    description: String,
    total_votes: Number,
    votes: [{
      user_id : { type: Number, unique: true },
      vote: Number
    }]
  }],
  nonessential_movie_parts: [{
    description: String,
    total_votes: Number,
    votes: [{
      user_id : { type: Number, unique: true },
      vote: Number
    }]
  }],
  comments: [{
    comment: String,
    user_id: Number,
  }]
})

module.exports = mongoose.model('Miam', MiamSchema)
