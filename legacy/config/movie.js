const mongoose = require('mongoose')
const Schema = mongoose.Schema

const MovieSchema = new Schema({
	imdbID: { type: String, unique: true },
	title: String,
	year: Number,
	rated: String,
	released: String,
	runtime: String,
	genre: String,
	director: String,
	writer: String,
	actors: String,
	plot: String,
	country: String,
	poster: String,
	imdbRating: Number,
	imdbVotes: Number,
	type: String,
	adaptation_id: mongoose.Schema.Types.ObjectId,
    title: String,
    priority: Number,
    image_url: String
})

module.exports = mongoose.model('Movie', MovieSchema)
