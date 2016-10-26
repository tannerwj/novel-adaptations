const mongoose = require('mongoose')
const Schema = mongoose.Schema

const BookSchema = new Schema({
  goodreads_id: { type: Number, unique: true },
  title: String,
  original_title: String,
  isbn: { type: String, unique: true },
  isbn13: { type: String, unique: true },
  image_url: String,
  small_image_url: String,
	description: String,
	publication_date: String,
	average_rating: String,
  authors: [{
    name:  String,
    role: String
  }],
  adaptations: [{
    adaptation_id: mongoose.Schema.Types.ObjectId,
    title: String,
    priority: Number,
    image_url: String
  }]
})

module.exports = mongoose.model('Book', BookSchema)
