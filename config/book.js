const mongoose = require('mongoose')
const Schema = mongoose.Schema

const BookSchema = new Schema({
  goodreads_id: { type: Number, unique: true },
  title: String,
  original_title: String,
  isbn: { type: String, unique: true },
  isbn13: { type: String, unique: true },
  image_url: { type: String, unique: true },
  small_image_url: { type: String, unique: true },
	description: String,
	publication_date: String,
	average_rating: String,
  authors: [{
    author_id: { type: Number, unique: true },
    name:  String,
    role: String
  }]
})

module.exports = mongoose.model('Book', BookSchema)
