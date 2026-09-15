-- 0002_seed.sql — demo data for the Phase 1 scaffold.
-- Explicit ids so detail routes (/adaptations/1, /books/1, ...) are predictable.
-- Cover URLs use Open Library covers by ISBN; poster_url is left NULL —
-- the UI must render gracefully without posters.

INSERT INTO books (id, title, authors, cover_url, pub_date, isbn) VALUES
  (1, 'Dune', 'Frank Herbert', 'https://covers.openlibrary.org/b/isbn/9780441172719-L.jpg', '1965-08-01', '9780441172719'),
  (2, 'The Fellowship of the Ring', 'J. R. R. Tolkien', 'https://covers.openlibrary.org/b/isbn/9780618346257-L.jpg', '1954-07-29', '9780618346257'),
  (3, 'Harry Potter and the Philosopher''s Stone', 'J. K. Rowling', 'https://covers.openlibrary.org/b/isbn/9780747532699-L.jpg', '1997-06-26', '9780747532699'),
  (4, 'The Hunger Games', 'Suzanne Collins', 'https://covers.openlibrary.org/b/isbn/9780439023481-L.jpg', '2008-09-14', '9780439023481'),
  (5, 'A Game of Thrones', 'George R. R. Martin', 'https://covers.openlibrary.org/b/isbn/9780553103540-L.jpg', '1996-08-01', '9780553103540'),
  (6, 'Fourth Wing', 'Rebecca Yarros', 'https://covers.openlibrary.org/b/isbn/9781649374042-L.jpg', '2023-04-05', '9781649374042'),
  (7, 'The Midnight Library', 'Matt Haig', 'https://covers.openlibrary.org/b/isbn/9780525559474-L.jpg', '2020-09-29', '9780525559474'),
  (8, 'A Court of Thorns and Roses', 'Sarah J. Maas', 'https://covers.openlibrary.org/b/isbn/9781619634442-L.jpg', '2015-05-05', '9781619634442');

INSERT INTO screen_works (id, title, kind, release_date) VALUES
  (1, 'Dune: Part Two', 'film', '2024-03-01'),
  (2, 'The Lord of the Rings: The Fellowship of the Ring', 'film', '2001-12-19'),
  (3, 'Harry Potter and the Philosopher''s Stone', 'film', '2001-11-16'),
  (4, 'The Hunger Games', 'film', '2012-03-23'),
  (5, 'Game of Thrones', 'series', '2011-04-17'),
  (6, 'Fourth Wing', 'series', NULL),
  (7, 'The Midnight Library', 'film', NULL),
  (8, 'A Court of Thorns and Roses', 'series', NULL);

INSERT INTO adaptations (id, book_id, screen_work_id, status, source_url) VALUES
  (1, 1, 1, 'released', 'https://en.wikipedia.org/wiki/Dune:_Part_Two'),
  (2, 2, 2, 'released', 'https://en.wikipedia.org/wiki/The_Lord_of_the_Rings:_The_Fellowship_of_the_Ring'),
  (3, 3, 3, 'released', 'https://en.wikipedia.org/wiki/Harry_Potter_and_the_Philosopher%27s_Stone_(film)'),
  (4, 4, 4, 'released', 'https://en.wikipedia.org/wiki/The_Hunger_Games_(film)'),
  (5, 5, 5, 'released', 'https://en.wikipedia.org/wiki/Game_of_Thrones'),
  (6, 6, 6, 'in_development', 'https://en.wikipedia.org/wiki/Fourth_Wing'),
  (7, 7, 7, 'optioned', 'https://en.wikipedia.org/wiki/The_Midnight_Library'),
  (8, 8, 8, 'rumored', 'https://en.wikipedia.org/wiki/A_Court_of_Thorns_and_Roses');
