const mongoose = require('mongoose')
const Schema = mongoose.Schema

const MovieSchema = new Schema({
	imdbID: { type: String, unique: true },
	title: String,
	Year: Number,
	Rated: String,
	Released: String,
	Runtime: String,
	Genre: String,
	Director: String,
	Writer: String,
	Actors: String,
	Plot: String,
	Language: String,
	Country: String,
	Awards: String,
	Poster: String,
	Metascore: Number,
	imdbRating: Number,
	imdbVotes: Number,
	Type: String
})

module.exports = mongoose.model('Movie', MovieSchema)