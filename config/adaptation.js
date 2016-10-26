const mongoose = require('mongoose')
const Schema = mongoose.Schema

const AdaptationSchema = new Schema({
  title: String,
  description: String,
  year_released: Number,
  director: String,
  writers: String,
  actors: String,
  rating: Number, //avg rating = total_rating / total_qty_ratings
  total_rating: Number, //0-5 each user, total added amount
  total_qty_ratings: Number, //qty of ratings placed
  ratings: [{
    user_id : { type: Number, unique: true },
    rating: Number
  }],
  movie_rating: Number,
  movie_image_url: String,
  imdb_id: { type: String, unique: true },
  //first book user selected to be adapted
  //can make this dynamic later
  book_rating: Number,
  book_image_url: String,
  book_isbn: String, //amazon https://www.amazon.com/dp/[isbn]?tag=novel-adaptations-20
  goodreads_id: { type: Number, unique: true },
  books: [{ //other books this was adapted from
    goodreads_id: { type: Number, unique: true },
    title:  String,
    image_url: String
  }],
  other_adaptations: [{
    adaptation_id: mongoose.Schema.Types.ObjectId,
    title: String,
    priority: Number,
    image_url: String
  }],
  parts_movie_missed: [{
    description: String,
    total_votes: Number,
    votes: [{
      user_id : { type: Number, unique: true },
      vote: Number
    }]
  }],
  parts_movie_added: [{
    description: String,
    total_votes: Number,
    votes: [{
      user_id : { type: Number, unique: true },
      vote: Number
    }]
  }],
  reviews: [{
    reivew: String,
    user_id: Number,
    total_votes: Number,
    votes: [{
      user_id : { type: Number, unique: true },
      vote: Number
    }]
  }]
})

module.exports = mongoose.model('Adaptation', AdaptationSchema)
