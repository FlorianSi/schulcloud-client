const express = require('express');
const path = require('path');
const favicon = require('serve-favicon');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');


// template stuff
const handlebars = require("handlebars");
const layouts = require("handlebars-layouts");
const handlebarsWax = require('handlebars-wax');

const app = express();

// view engine setup
const handlebarsHelper = require('./helpers/handlebars');
const wax = handlebarsWax(handlebars)
    .partials(path.join(__dirname, 'views/**/*.{hbs,js}'))
    .helpers(layouts)
    .helpers(handlebarsHelper.helpers);

app.use(handlebarsHelper.middleware);

app.engine("hbs", wax.engine);
app.set("view engine", "hbs");

app.set('views', path.join(__dirname, 'views'));

// uncomment after placing your favicon in /public
//app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'build')));


// Initialize the modules and their routes
app.use(require('./controllers/'));

app.get('/', (req,res,next) => {
    res.redirect('/login/');
});

// catch 404 and forward to error handler
app.use(function (req, res, next) {
    const err = new Error('Not Found');
    err.status = 404;
    next(err);
});

// error handler
app.use(function (err, req, res, next) {
    // set locals, only providing error in development
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};

    // render the error page
    res.status(err.status || 500);
    res.render('lib/error');
});

module.exports = app;
