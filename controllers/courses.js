/* eslint-disable no-underscore-dangle */
const _ = require('lodash');
const express = require('express');
const winston = require('winston');
const moment = require('moment');
const api = require('../api');
const authHelper = require('../helpers/authentication');
const recurringEventsHelper = require('../helpers/recurringEvents');
const permissionHelper = require('../helpers/permissions');


const router = express.Router();

const logger = winston.createLogger({
	transports: [
		new winston.transports.Console({
			format: winston.format.combine(
				winston.format.colorize(),
				winston.format.simple(),
			),
		}),
	],
});

const getSelectOptions = (req, service, query) => api(req).get(`/${service}`, {
	qs: query,
}).then(data => data.data);


const markSelected = (options, values = []) => options.map((option) => {
	option.selected = values.includes(option._id);
	return option;
});


/**
 * creates an event for a created course. following params has to be included in @param course for creating the event:
 * startDate {Date} - the date the course is first take place
 * untilDate {Date} -  the date the course is last take place
 * duration {Number} - the duration of a course lesson
 * weekday {Number} - from 0 to 6, the weekday the course take place
 * @param course
 */
const createEventsForCourse = (req, res, course) => {
	// can just run if a calendar service is running on the environment
	if (process.env.CALENDAR_SERVICE_ENABLED) {
		return Promise.all(course.times.map(time => api(req).post('/calendar', {
			json: {
				summary: course.name,
				location: time.room,
				description: course.description,
				startDate: new Date(new Date(course.startDate).getTime() + time.startTime).toLocalISOString(),
				duration: time.duration,
				repeat_until: course.untilDate,
				frequency: 'WEEKLY',
				weekday: recurringEventsHelper.getIsoWeekdayForNumber(time.weekday),
				scopeId: course._id,
				courseId: course._id,
				courseTimeId: time._id,
			},
		}))).catch((error) => {
			logger.warn('failed creating events for the course, the calendar service might be unavailible', error);
			req.session.notification = {
				type: 'danger',
				message: 'Die Kurszeiten konnten eventuell nicht richtig gespeichert werden.'
				+ 'Wenn du diese Meldung erneut siehst, kontaktiere bitte den Support.',
			};
			return Promise.resolve();
		});
	}

	return Promise.resolve(true);
};

/**
 * Deletes all events from the given course, clear function
 * @param courseId {string} - the id of the course the events will be deleted
 */
const deleteEventsForCourse = (req, res, courseId) => {
	if (process.env.CALENDAR_SERVICE_ENABLED) {
		return api(req).get(`courses/${courseId}`).then(course => Promise.all((course.times || []).map((t) => {
			if (t.eventId) {
				return api(req).delete(`calendar/${t.eventId}`);
			}
			return Promise.resolve();
		})).catch((error) => {
			logger.warn('failed creating events for the course, the calendar service might be unavailible', error);
			req.session.notification = {
				type: 'danger',
				message: 'Die Kurszeiten konnten eventuell nicht richtig gespeichert werden.'
				+ 'Wenn du diese Meldung erneut siehst, kontaktiere bitte den Support.',
			};
			return Promise.resolve();
		}));
	}
	return Promise.resolve(true);
};

const editCourseHandler = (req, res, next) => {
	let coursePromise;
	let action;
	let method;
	if (req.params.courseId) {
		action = `/courses/${req.params.courseId}`;
		method = 'patch';
		coursePromise = api(req).get(`/courses/${req.params.courseId}`, {
			qs: {
				$populate: ['ltiToolIds', 'classIds', 'teacherIds', 'userIds', 'substitutionIds'],
			},
		});
	} else {
		action = '/courses/';
		method = 'post';
		coursePromise = Promise.resolve({});
	}

	const classesPromise = api(req).get('/classes', {
		qs: {
			schoolId: res.locals.currentSchool,
			$populate: ['year'],
			$limit: 1000,
		},
	}).then(data => data.data);
	const teachersPromise = getSelectOptions(req, 'users', { roles: ['teacher', 'demoTeacher'], $limit: false });
	const studentsPromise = getSelectOptions(req, 'users', { roles: ['student', 'demoStudent'], $limit: false });

	Promise.all([
		coursePromise,
		classesPromise,
		teachersPromise,
		studentsPromise,
	]).then(([course, _classes, _teachers, _students]) => {
		// these 3 might not change anything because hooks allow just ownSchool results by now, but to be sure:
		const classes = _classes.filter(c => c.schoolId === res.locals.currentSchool);
		const teachers = _teachers.filter(t => t.schoolId === res.locals.currentSchool);
		const students = _students.filter(s => s.schoolId === res.locals.currentSchool);
		const substitutions = _.cloneDeep(teachers.filter(t => t._id !== res.locals.currentUser._id));

		// map course times to fit into UI
		(course.times || []).forEach((time, count) => {
			time.duration = time.duration / 1000 / 60;
			const duration = moment.duration(time.startTime);
			const hoursString = (`00${duration.hours()}`).slice(-2);
			const minutsString = (`00${duration.minutes()}`).slice(-2);
			time.startTime = `${hoursString}:${minutsString}`;
			time.count = count;
		});

		// format course start end until date
		if (course.startDate) {
			course.startDate = moment(new Date(course.startDate).getTime()).format('DD.MM.YYYY');
			course.untilDate = moment(new Date(course.untilDate).getTime()).format('DD.MM.YYYY');
		}

		// preselect current teacher when creating new course
		if (!req.params.courseId) {
			course.teacherIds = [];
			course.teacherIds.push(res.locals.currentUser);
		}

		// populate course colors - to be replaced system scope
		const colors = [
			'#ACACAC',
			'#D4AF37',
			'#00E5FF',
			'#1DE9B6',
			'#546E7A',
			'#FFC400',
			'#BCAAA4',
			'#FF4081',
			'#FFEE58',
		];

		if (req.params.courseId) {
			res.render('courses/edit-course', {
				action,
				method,
				title: 'Kurs bearbeiten',
				submitLabel: 'Änderungen speichern',
				closeLabel: 'Abbrechen',
				course,
				colors,
				classes: markSelected(classes, _.map(course.classIds, '_id')),
				teachers: markSelected(teachers, _.map(course.teacherIds, '_id')),
				substitutions: markSelected(substitutions, _.map(course.substitutionIds, '_id')),
				students: markSelected(students, _.map(course.userIds, '_id')),
			});
		} else {
			res.render('courses/create-course', {
				action,
				method,
				sectionTitle: 'Kurs anlegen',
				submitLabel: 'Kurs anlegen und Weiter',
				closeLabel: 'Abbrechen',
				course,
				colors,
				classes: markSelected(classes, _.map(course.classIds, '_id')),
				teachers: markSelected(teachers, _.map(course.teacherIds, '_id')),
				substitutions: markSelected(substitutions, _.map(course.substitutionIds, '_id')),
				students: markSelected(students, _.map(course.userIds, '_id')),
			});
		}
	});
};

const sameId = (id1, id2) => id1.toString() === id2.toString();

const copyCourseHandler = (req, res, next) => {
	let coursePromise;
	let action;
	let method;
	if (req.params.courseId) {
		action = `/courses/copy/${req.params.courseId}`;
		method = 'post';
		coursePromise = api(req).get(`/courses/${req.params.courseId}`, {
			qs: {
				$populate: ['ltiToolIds', 'classIds', 'teacherIds', 'userIds', 'substitutionIds'],
			},
		});
	} else {
		action = '/courses/copy';
		method = 'post';
		coursePromise = Promise.resolve({});
	}

	const classesPromise = getSelectOptions(req, 'classes', { $limit: 1000 });
	const teachersPromise = getSelectOptions(req, 'users', { roles: ['teacher', 'demoTeacher'], $limit: 1000 });
	const studentsPromise = getSelectOptions(req, 'users', { roles: ['student', 'demoStudent'], $limit: 1000 });

	Promise.all([
		coursePromise,
		classesPromise,
		teachersPromise,
		studentsPromise,
	]).then(([course, _classes, _teachers, _students]) => {
		const classes = _classes.filter(c => sameId(c.schoolId, res.locals.currentSchool));
		const teachers = _teachers.filter(t => sameId(t.schoolId, res.locals.currentSchool));
		const students = _students.filter(s => sameId(s.schoolId, res.locals.currentSchool));
		const substitutions = _.cloneDeep(teachers);

		// map course times to fit into UI
		(course.times || []).forEach((time, count) => {
			time.duration = time.duration / 1000 / 60;
			const duration = moment.duration(time.startTime);
			const hoursString = (`00${duration.hours()}`).slice(-2);
			const minutsString = (`00${duration.minutes()}`).slice(-2);
			time.startTime = `${hoursString}:${minutsString}`;
			time.count = count;
		});

		// format course start end until date
		if (course.startDate) {
			course.startDate = moment(new Date(course.startDate).getTime()).format('DD.MM.YYYY');
			course.untilDate = moment(new Date(course.untilDate).getTime()).format('DD.MM.YYYY');
		}

		// preselect current teacher when creating new course
		if (!req.params.courseId) {
			course.teacherIds = [];
			course.teacherIds.push(res.locals.currentUser);
		}

		// populate course colors - to be replaced system scope
		const colors = [
			'#ACACAC',
			'#D4AF37',
			'#00E5FF',
			'#1DE9B6',
			'#546E7A',
			'#FFC400',
			'#BCAAA4',
			'#FF4081',
			'#FFEE58',
		];

		course.name = `${course.name} - Kopie`;

		res.render('courses/edit-course', {
			action,
			method,
			title: 'Kurs klonen',
			submitLabel: 'Kurs klonen',
			closeLabel: 'Abbrechen',
			course,
			classes,
			colors,
			teachers: markSelected(teachers, _.map(course.teacherIds, '_id')),
			substitutions,
			students,
		});
	});
};

// secure routes
router.use(authHelper.authChecker);


/*
 * Courses
 */
const setTimeAndRoomOverview = (course, time) => {
	const startTime = moment(time.startTime, 'x').utc().format('HH:mm');
	const weekday = recurringEventsHelper.getWeekdayForNumber(time.weekday);
	const room = time.room ? `| ${time.room}` : '';
	const addTitle = `<div>${weekday} ${startTime} ${room}</div>`;
	course.secondaryTitle += addTitle;
};
router.get('/', (req, res, next) => {
	Promise.all([
		api(req).get('/courses/', {
			qs: {
				substitutionIds: res.locals.currentUser._id,
				$limit: 75,
			},
		}),
		api(req).get('/courses/', {
			qs: {
				$or: [
					{ userIds: res.locals.currentUser._id },
					{ teacherIds: res.locals.currentUser._id },
				],
				$limit: 75,
			},
		}),
	]).then(([_substitutionCourses, _courses]) => {
		const substitutionCourses = _substitutionCourses.data.map((course) => {
			course.url = `/courses/${course._id}`;
			course.title = course.name;
			course.content = (course.description || '').substr(0, 140);
			course.secondaryTitle = '';
			course.background = course.color;
			course.memberAmount = course.userIds.length;
			(course.times || []).forEach((time) => {
				setTimeAndRoomOverview(course, time);
			});
			return course;
		});

		const courses = _courses.data.map((course) => {
			course.url = `/courses/${course._id}`;
			course.title = course.name;
			course.content = (course.description || '').substr(0, 140);
			course.secondaryTitle = '';
			course.background = course.color;
			course.memberAmount = course.userIds.length;
			(course.times || []).forEach((time) => {
				setTimeAndRoomOverview(course, time);
			});

			return course;
		});

		const isStudent = res.locals.currentUser.roles.every(role => role.name === 'student');

		if (req.query.json) {
			res.json(courses);
		} else if (courses.length > 0 || substitutionCourses.length > 0) {
			res.render('courses/overview', {
				title: 'Meine Kurse',
				courses,
				substitutionCourses,
				searchLabel: 'Suche nach Kursen',
				searchAction: '/courses',
				showSearch: true,
				liveSearch: true,
			});
		} else {
			res.render('courses/overview-empty', {
				isStudent,
			});
		}
	}).catch((err) => {
		next(err);
	});
});

router.post('/', (req, res, next) => {
	// map course times to fit model
	(req.body.times || []).forEach((time) => {
		time.startTime = moment.duration(time.startTime, 'HH:mm').asMilliseconds();
		time.duration = time.duration * 60 * 1000;
	});

	req.body.startDate = moment(req.body.startDate, 'DD:MM:YYYY')._d;
	req.body.untilDate = moment(req.body.untilDate, 'DD:MM:YYYY')._d;

	if (!(moment(req.body.startDate, 'YYYY-MM-DD').isValid())) {
		delete req.body.startDate;
	}
	if (!(moment(req.body.untilDate, 'YYYY-MM-DD').isValid())) {
		delete req.body.untilDate;
	}

	api(req).post('/courses/', {
		json: req.body, // TODO: sanitize
	}).then((course) => {
		createEventsForCourse(req, res, course).then(() => {
			res.redirect('/courses');
		});
	}).catch(() => {
		res.sendStatus(500);
	});
});

router.post('/copy/:courseId', (req, res, next) => {
	// map course times to fit model
	(req.body.times || []).forEach((time) => {
		time.startTime = moment.duration(time.startTime, 'HH:mm').asMilliseconds();
		time.duration = time.duration * 60 * 1000;
	});

	req.body.startDate = moment(req.body.startDate, 'DD:MM:YYYY')._d;
	req.body.untilDate = moment(req.body.untilDate, 'DD:MM:YYYY')._d;

	if (!(moment(req.body.startDate, 'YYYY-MM-DD').isValid())) {
		delete req.body.startDate;
	}
	if (!(moment(req.body.untilDate, 'YYYY-MM-DD').isValid())) {
		delete req.body.untilDate;
	}

	req.body._id = req.params.courseId;
	// req.body.courseId = req.params.courseId;
	req.body.copyCourseId = req.params.courseId;

	api(req).post('/courses/copy/', {
		json: req.body, // TODO: sanitize
	}).then((course) => {
		res.redirect(`/courses/${course._id}`);
	}).catch(() => {
		res.sendStatus(500);
	});
});


router.get('/add/', editCourseHandler);


/*
 * Single Course
 */

router.get('/:courseId/json', (req, res, next) => {
	Promise.all([
		api(req).get(`/courses/${req.params.courseId}`, {
			qs: {
				$populate: ['ltiToolIds'],
			},
		}),
		api(req).get('/lessons/', {
			qs: {
				courseId: req.params.courseId,
			},
		}),
	]).then(([course, lessons]) => res.json({ course, lessons }))
		.catch((err) => {
			next(err);
		});
});

router.get('/:courseId/usersJson', (req, res, next) => {
	Promise.all([
		api(req).get(`/courses/${req.params.courseId}`, {
			qs: {
				$populate: ['userIds'],
			},
		}),
	]).then(([course]) => res.json({ course }))
		.catch((err) => {
			next(err);
		});
});

// EDITOR

router.get('/:courseId/', (req, res, next) => {
	Promise.all([
		api(req).get(`/courses/${req.params.courseId}`, {
			qs: {
				$populate: ['ltiToolIds'],
			},
		}),
		api(req).get('/lessons/', {
			qs: {
				courseId: req.params.courseId,
				$sort: 'position',
			},
		}),
		api(req).get('/homework/', {
			qs: {
				courseId: req.params.courseId,
				$populate: ['courseId'],
				archived: { $ne: res.locals.currentUser._id },
			},
		}),
		api(req).get('/courseGroups/', {
			qs: {
				courseId: req.params.courseId,
				$populate: ['courseId', 'userIds'],
			},
		}),
	]).then(([course, _lessons, _homeworks, _courseGroups]) => {
		const ltiToolIds = (course.ltiToolIds || []).filter(ltiTool => ltiTool.isTemplate !== 'true');
		const lessons = (_lessons.data || []).map(lesson => Object.assign(lesson, {
			url: `/courses/${req.params.courseId}/topics/${lesson._id}/`,
		}));

		const homeworks = (_homeworks.data || []).map((assignment) => {
			assignment.url = `/homework/${assignment._id}`;
			return assignment;
		});

		homeworks.sort((a, b) => {
			if (a.dueDate > b.dueDate) {
				return 1;
			}
			return -1;
		});

		const courseGroups = permissionHelper.userHasPermission(res.locals.currentUser, 'COURSE_EDIT')
			? _courseGroups.data || []
			: (_courseGroups.data || []).filter(cg => cg.userIds.some(user => user._id === res.locals.currentUser._id));

		res.render('courses/course', Object.assign({}, course, {
			title: course.name,
			activeTab: req.query.activeTab,
			lessons,
			homeworks: homeworks.filter(task => !task.private),
			myhomeworks: homeworks.filter(task => task.private),
			ltiToolIds,
			courseGroups,
			breadcrumb: [{
				title: 'Meine Kurse',
				url: '/courses',
			},
			{
				title: course.name,
				url: `/courses/${course._id}`,
			},
			],
			filesUrl: `/files/courses/${req.params.courseId}`,
			nextEvent: recurringEventsHelper.getNextEventForCourseTimes(course.times),
		}));
	}).catch((err) => {
		next(err);
	});
});


router.patch('/:courseId', (req, res, next) => {
	// map course times to fit model
	req.body.times = req.body.times || [];
	req.body.times.forEach((time) => {
		time.startTime = moment.duration(time.startTime).asMilliseconds();
		time.duration = time.duration * 60 * 1000;
	});

	req.body.startDate = moment(req.body.startDate, 'DD:MM:YYYY')._d;
	req.body.untilDate = moment(req.body.untilDate, 'DD:MM:YYYY')._d;

	if (!req.body.classIds) { req.body.classIds = []; }
	if (!req.body.userIds) { req.body.userIds = []; }
	if (!req.body.substitutionIds) { req.body.substitutionIds = []; }

	if (!(moment(req.body.startDate, 'YYYY-MM-DD').isValid())) { delete req.body.startDate; }
	if (!(moment(req.body.untilDate, 'YYYY-MM-DD').isValid())) { delete req.body.untilDate; }

	// first delete all old events for the course
	deleteEventsForCourse(req, res, req.params.courseId).then(() => {
		api(req).patch(`/courses/${req.params.courseId}`, {
			json: req.body, // TODO: sanitize
		}).then((course) => {
			createEventsForCourse(req, res, course).then(() => {
				res.redirect(303, `/courses/${req.params.courseId}`);
			});
		});
	}).catch(() => {
		res.sendStatus(500);
	});
});

router.patch('/:courseId/positions', (req, res, next) => {
	Object.keys(req.body).forEach((key) => {
		api(req).patch(`/lessons/${key}`, {
			json: {
				position: parseInt(req.body[key], 10),
				courseId: req.params.courseId,
			},
		});
	});
	res.sendStatus(200);
});


router.delete('/:courseId', (req, res, next) => {
	deleteEventsForCourse(req, res, req.params.courseId).then(() => {
		api(req).delete(`/courses/${req.params.courseId}`).then(() => {
			res.sendStatus(200);
		});
	}).catch(() => {
		res.sendStatus(500);
	});
});

router.get('/:courseId/addStudent', (req, res, next) => {
	const { currentUser } = res.locals;
	// if currentUser isn't a student don't add to course-students
	if (currentUser.roles.filter(r => r.name === 'student').length <= 0) {
		req.session.notification = {
			type: 'danger',
			message: "Sie sind kein Nutzer der Rolle 'Schüler'.",
		};
		res.redirect(`/courses/${req.params.courseId}`);
		return;
	}

	// check if student is already in course
	api(req).get(`/courses/${req.params.courseId}?link=${req.query.link}`).then((course) => {
		if (_.includes(course.userIds, currentUser._id)) {
			req.session.notification = {
				type: 'danger',
				message: `Sie sind bereits Teilnehmer des Kurses/Fachs ${course.name}.`,
			};
			res.redirect(`/courses/${req.params.courseId}`);
			return;
		}

		// add Student to course
		course.userIds.push(currentUser._id);
		// eslint-disable-next-line consistent-return
		return api(req).patch(`/courses/${course._id}?link=${req.query.link}`, {
			json: course,
		}).then(() => {
			req.session.notification = {
				type: 'success',
				message: `Sie wurden erfolgreich beim Kurs/Fach ${course.name} hinzugefügt`,
			};
			res.redirect(`/courses/${req.params.courseId}`);
		});
	}).catch((err) => {
		next(err);
	});
});

router.post('/:courseId/importTopic', (req, res, next) => {
	const { shareToken } = req.body;
	// try to find topic for given shareToken
	api(req).get('/lessons/', { qs: { shareToken, $populate: ['courseId'] } }).then((lessons) => {
		if ((lessons.data || []).length <= 0) {
			req.session.notification = {
				type: 'danger',
				message: 'Es wurde kein Thema für diesen Code gefunden.',
			};

			res.redirect(req.header('Referer'));
		}

		api(req).post('/lessons/copy', {
			json: {
				lessonId: lessons.data[0]._id,
				newCourseId: req.params.courseId,
				shareToken,
			},
		})
			.then(() => {
				res.redirect(req.header('Referer'));
			});
	}).catch(err => res.status((err.statusCode || 500)).send(err));
});


router.get('/:courseId/edit', editCourseHandler);

router.get('/:courseId/copy', copyCourseHandler);

// return shareToken
router.get('/:id/share', (req, res, next) => api(req).get(`/courses/share/${req.params.id}`)
	.then(course => res.json(course)));

// return course Name for given shareToken
router.get('/share/:id', (req, res, next) => api(req).get('/courses/share', { qs: { shareToken: req.params.id } })
	.then(name => res.json({ msg: name, status: 'success' }))
	.catch(() => res.json({ msg: 'ShareToken is not in use.', status: 'error' })));

router.post('/import', (req, res, next) => {
	const { shareToken } = req.body;
	const courseName = req.body.name;

	api(req).post('/courses/share', { json: { shareToken, courseName } })
		.then((course) => {
			res.redirect(`/courses/${course._id}/edit/`);
		})
		.catch((err) => {
			res.status((err.statusCode || 500)).send(err);
		});
});

module.exports = router;
