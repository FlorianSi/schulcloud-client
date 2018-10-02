const express = require('express');
const router = express.Router();

// only execute middleware on this router
const handlebarsHelper = require('../helpers/handlebars');
router.use(handlebarsHelper.middleware);

// Track page views in Google Analytics
const googleAnalyticsHelper = require('../helpers/googleAnalytics');
router.use(googleAnalyticsHelper.middleware());

// HOMEPAGE
router.use(require('./homepage/login'));
router.use(require('./registration'));

router.use('/about/', require('./homepage/about'));
router.use('/community/', require('./homepage/community'));
router.use('/impressum/', require('./homepage/imprint'));
router.use('/partner/', require('./homepage/partner'));
router.use('/team', require('./homepage/team'));

// SERVICES
router.use('/link/', require('./link'));
router.use('/notification/', require('./notification'));
router.use('/help/', require('./help'));

// LOGGEDIN
// Account
router.use('/account/', require('./account'));
router.use('/firstLogin', require('./firstLogin'));
router.use('/pwrecovery/', require('./pwrecovery'));

// Calendar
router.use('/calendar/', require('./calendar'));
// Content
router.use('/content/', require('./content'));
// Courses
router.use('/courses/', require('./courses'));
router.use('/courses/:courseId/topics/', require('./topics'));
router.use('/courses/:courseId/tools/', require('./tools'));
router.use('/courses/:courseId/groups/', require('./coursegroups'));
// Dashboard
router.use('/dashboard/', require('./dashboard'));
// Files
router.use('/files/', require('./files'));
// Homework
router.use('/homework/', require('./homework'));
// News
router.use('/news/', require('./news'));
// Materialien
router.use('/my-material', require('./my-material'));
// Administration
// TODO: Split /administration controller into sections (/students, /teachers, /classes, ...)
router.use('/administration/', require('./administration')); 
router.use('/helpdesk/', require('./helpdesk'));

module.exports = router;
