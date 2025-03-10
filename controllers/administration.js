/* eslint-disable prefer-destructuring */
/*
 * One Controller per layout view
 */

const express = require('express');
const logger = require('winston');
const moment = require('moment');
const multer = require('multer');
const api = require('../api');
const authHelper = require('../helpers/authentication');
const permissionsHelper = require('../helpers/permissions');
const recurringEventsHelper = require('../helpers/recurringEvents');
// eslint-disable-next-line import/order
const StringDecoder = require('string_decoder').StringDecoder;
// eslint-disable-next-line import/order
const _ = require('lodash');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
const decoder = new StringDecoder('utf8');

moment.locale('de');

// eslint-disable-next-line no-unused-vars
const getSelectOptions = (req, service, query, values = []) => api(req)
	.get(`/${service}`, {
		qs: query,
	})
	.then(data => data.data);

const getSelectableYears = (school) => {
	let years = [];
	if (school && school.years) {
		years = years.concat([
			school.years.activeYear,
			school.years.nextYear,
			school.years.lastYear,
		].filter(y => !!y));
	}
	return years;
};

const cutEditOffUrl = (url) => {
	// nicht optimal, aber req.header('Referer')
	// gibt auf einer edit Seite die edit Seite, deshalb diese URL Manipulation
	let workingURL = url;
	if (url.endsWith('/edit')) {
		workingURL = workingURL.replace('/edit', '');
		workingURL = workingURL.substring(0, workingURL.lastIndexOf('/'));
	}
	return workingURL;
};

const getTableActions = (
	item,
	path,
	isAdmin = true,
	isTeacher = false,
	isStudentAction = false,
	category,
) => {
	let editButtonClass = 'btn-edit';
	if (item.type === 'ldap') {
		editButtonClass = 'btn-edit-ldap';
	}
	return [
		{
			link:
				item.type === 'ldap' ? `${path}ldap/edit/${item._id}` : path + item._id,
			class: `${editButtonClass} ${isTeacher ? 'disabled' : ''}`,
			icon: 'edit',
			title: 'Eintrag bearbeiten',
		},
		{
			link: path + item._id,
			class: `${isAdmin ? 'btn-delete' : 'disabled'} ${category === 'systems'
				&& 'btn-delete--systems'}`,
			icon: 'trash-o',
			method: `${isAdmin ? 'delete' : ''}`,
			title: 'Eintrag löschen',
		},
		{
			link: isStudentAction ? `${path}pw/${item._id}` : '',
			class: isStudentAction ? 'btn-pw' : 'invisible',
			icon: isStudentAction ? 'key' : '',
			title: 'Passwort zurücksetzen',
		},
	];
};

const getTableActionsSend = (item, path, state) => {
	const actions = [];
	if (state === 'submitted' || state === 'closed') {
		actions.push(
			{
				link: path + item._id,
				class: 'btn-edit',
				icon: 'edit',
				title: 'Eintrag bearbeiten',
			},
			{
				class: 'disabled',
				icon: 'archive',
			},
			{
				class: 'disabled',
				icon: 'paper-plane',
			},
		);
	} else {
		actions.push(
			{
				link: path + item._id,
				class: 'btn-edit',
				icon: 'edit',
				title: 'Eintrag bearbeiten',
			},
			{
				link: path + item._id,
				class: 'btn-disable',
				icon: 'archive',
				method: 'delete',
				title: 'Eintrag abschließen',
			},
			{
				link: path + item._id,
				class: 'btn',
				icon: 'paper-plane',
				method: 'post',
				title: 'Eintrag an Entwicklerteam senden',
			},
		);
	}
	return actions;
};

/**
 * maps the event props from the server to fit the ui components, e.g. date and time
 * @param data {object} - the plain data object
 * @param service {string} - the model or service type
 */
const mapEventProps = (data, service) => {
	if (service === 'courses') {
		// map course times to fit into UI
		(data.times || []).forEach((time, count) => {
			time.duration = time.duration / 1000 / 60;
			time.startTime = moment(time.startTime, 'x').format('HH:mm');
			time.count = count;
		});

		// format course start end until date
		if (data.startDate) {
			data.startDate = moment(new Date(data.startDate).getTime()).format(
				'YYYY-MM-DD',
			);
			data.untilDate = moment(new Date(data.untilDate).getTime()).format(
				'YYYY-MM-DD',
			);
		}
	}

	return data;
};

/**
 * sets undefined array-course properties to an empty array
 */
const mapEmptyCourseProps = (req, res, next) => {
	const courseBody = req.body;
	if (!courseBody.classIds) courseBody.classIds = [];
	if (!courseBody.teacherIds) courseBody.teacherIds = [];
	if (!courseBody.userIds) courseBody.userIds = [];
	if (!courseBody.substitutionIds) courseBody.substitutionIds = [];

	next();
};

/**
 * sets undefined array-class properties to an empty array
 */
const mapEmptyClassProps = (req, res, next) => {
	const classBody = req.body;
	if (!classBody.teacherIds) classBody.teacherIds = [];
	if (!classBody.userIds) classBody.userIds = [];
	next();
};

/**
 * maps the request-data to fit model, e.g. for course times
 * @param data {object} - the request-data object
 * @param service {string} - maps
 */
const mapTimeProps = (req, res, next) => {
	// map course times to fit model
	req.body.times = req.body.times || [];
	(req.body.times || []).forEach((time) => {
		time.startTime = moment.duration(time.startTime, 'HH:mm').asMilliseconds();
		time.duration = time.duration * 60 * 1000;
	});

	next();
};

/**
 * creates an event for a created course. following params has to be included in @param data for creating the event:
 * startDate {Date} - the date the course is first take place
 * untilDate {Date} -  the date the course is last take place
 * duration {Number} - the duration of a course lesson
 * weekday {Number} - from 0 to 6, the weekday the course take place
 * @param data {object}
 * @param service {string}
 */
const createEventsForData = (data, service, req, res) => {
	// can just run if a calendar service is running on the environment and the course have a teacher
	if (
		process.env.CALENDAR_SERVICE_ENABLED
		&& service === 'courses'
		&& data.teacherIds[0]
		&& data.times.length > 0
	) {
		return Promise.all(
			data.times.map(time => api(req).post('/calendar', {
				json: {
					summary: data.name,
					location: res.locals.currentSchoolData.name,
					description: data.description,
					startDate: new Date(
						new Date(data.startDate).getTime() + time.startTime,
					).toISOString(),
					duration: time.duration,
					repeat_until: data.untilDate,
					frequency: 'WEEKLY',
					weekday: recurringEventsHelper.getIsoWeekdayForNumber(time.weekday),
					scopeId: data._id,
					courseId: data._id,
					courseTimeId: time._id,
				},
				qs: { userId: data.teacherIds[0] },
			})),
		);
	}

	return Promise.resolve(true);
};

/**
 * Deletes all events from the given dataId in @param req.params, clear function
 * @param service {string}
 */
const deleteEventsForData = service => (req, res, next) => {
	if (process.env.CALENDAR_SERVICE_ENABLED && service === 'courses') {
		return api(req)
			.get(`courses/${req.params.id}`)
			.then((course) => {
				if (course.teacherIds.length < 1 || course.times.length < 1) {
					// if no teacher, no permission for deleting
					next();
					return;
				}
				// eslint-disable-next-line consistent-return
				return Promise.all(
					// eslint-disable-next-line
					(course.times || []).map(t => {
						if (t.eventId) {
							return api(req).delete(`calendar/${t.eventId}`, {
								qs: { userId: course.teacherIds[0] },
							});
						}
					}),
				).then(() => next());
			});
	}

	return next();
};

/**
 * Generates short registration link, optionally with user hash.
 * email and sendMail will be gathered from req.body of not set.
 * @param params {
 *          role: user role = string "teacher"/"student"
 *          save: hash will be generated with URI-safe characters
 *          patchUser: hash will be patched into the user (DB)
 *          host: current webaddress from client = string, looks for req.headers.origin first
 *          schoolId: users schoolId = string
 *          toHash: optional, user account mail for hash generation = string
 *      }
 */
const generateRegistrationLink = (params, internalReturn) => function registrationLink(req, res, next) {
	const options = JSON.parse(JSON.stringify(params));
	if (!options.role) options.role = req.body.role || '';
	if (!options.save) options.save = req.body.save || '';
	if (!options.patchUser) options.patchUser = req.body.patchUser || '';
	if (!options.host) options.host = req.headers.origin || req.body.host || '';
	if (!options.schoolId) options.schoolId = req.body.schoolId || '';
	if (!options.toHash) {
		options.toHash = req.body.email || req.body.toHash || '';
	}

	if (internalReturn) {
		return api(req).post('/registrationlink/', {
			json: options,
		});
	}
	return api(req)
		.post('/registrationlink/', {
			json: options,
		})
		.then((linkData) => {
			res.locals.linkData = linkData;
			if (options.patchUser) req.body.importHash = linkData.hash;
			next();
		})
		.catch((err) => {
			req.session.notification = {
				type: 'danger',
				message: `Fehler beim Erstellen des Registrierungslinks.
          Bitte selbstständig Registrierungslink im Nutzerprofil generieren und weitergeben.
          ${(err.error || {}).message || err.message || err || ''}`,
			};
			res.redirect(req.header('Referer'));
		});
};

// secure routes
router.use(authHelper.authChecker);

// client-side use
router.post(
	'/registrationlink/',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'TEACHER_CREATE'], 'or'),
	generateRegistrationLink({}),
	(req, res) => {
		res.json(res.locals.linkData);
	},
);

const sendMailHandler = (user, req, res, internalReturn) => {
	if (
		user
		&& user.email
		&& user.schoolId
		&& (user.shortLink || res.locals.linkData.shortLink)
	) {
		return api(req)
			.post('/mails/', {
				json: {
					email: user.email,
					subject: `Einladung für die Nutzung der ${res.locals.theme.title}!`,
					headers: {},
					content: {
						text: `Einladung in die ${res.locals.theme.title}
Hallo ${user.firstName} ${user.lastName}!
\nDu wurdest eingeladen, der ${
	res.locals.theme.title
} beizutreten, bitte vervollständige deine Registrierung unter folgendem Link: ${user.shortLink
							|| res.locals.linkData.shortLink}
\nViel Spaß und einen guten Start wünscht dir dein
${res.locals.theme.short_title}-Team`,
					},
				},
			})
			.then(() => {
				if (internalReturn) return true;
				req.session.notification = {
					type: 'success',
					message:
						'Nutzer erfolgreich erstellt und Registrierungslink per E-Mail verschickt.',
				};
				return res.redirect(req.header('Referer'));
			})
			.catch((err) => {
				if (internalReturn) return false;
				req.session.notification = {
					type: 'danger',
					message: `Nutzer erstellt. Fehler beim Versenden der E-Mail.
            Bitte selbstständig Registrierungslink im Nutzerprofil generieren und weitergeben.
            ${(err.error || {}).message || err.message || err || ''}`,
				};
				return res.redirect(req.header('Referer'));
			});
	}
	if (internalReturn) return true;
	req.session.notification = {
		type: 'success',
		message: 'Nutzer erfolgreich erstellt.',
	};
	return res.redirect(req.header('Referer'));

	/* deprecated code for template-based e-mails - we keep that for later copy&paste
    fs.readFile(path.join(__dirname, '../views/template/registration.hbs'), (err, data) => {
        if (!err) {
            let source = data.toString();
            let template = handlebars.compile(source);
            let outputString = template({
                "url": (req.headers.origin || process.env.HOST) + "/register/account/" + user._id,
                "firstName": user.firstName,
                "lastName": user.lastName
            });

            let content = {
                "html": outputString,
                "text": "Sehr geehrte/r " + user.firstName + " " + user.lastName + ",\n\n" +
                    "Sie wurden in die Schul-Cloud eingeladen, bitte registrieren Sie sich unter folgendem Link:\n" +
                    (req.headers.origin || process.env.HOST) + "/register/account/" + user._id + "\n\n" +
                    "Mit Freundlichen Grüßen" + "\nIhr Schul-Cloud Team"
            };
            req.body.content = content;
        }
    }); */
};

const getUserCreateHandler = internalReturn => function userCreate(req, res, next) {
	const { shortLink } = req.body;
	if (req.body.birthday) {
		const birthday = req.body.birthday.split('.');
		req.body.birthday = `${birthday[2]}-${birthday[1]}-${
			birthday[0]
		}T00:00:00Z`;
	}
	return api(req)
		.post('/users/', {
			json: req.body,
		})
		.then(async (newuser) => {
			res.locals.createdUser = newuser;
			if (req.body.sendRegistration && newuser.email && newuser.schoolId) {
				newuser.shortLink = shortLink;
				return sendMailHandler(newuser, req, res, internalReturn);
			}
			if (internalReturn) return true;
			req.session.notification = {
				type: 'success',
				message: 'Nutzer erfolgreich erstellt.',
			};
			return res.redirect(req.header('Referer'));

			/*
            createEventsForData(data, service, req, res).then(_ => {
                next();
            });
            */
		})
		.catch((err) => {
			if (internalReturn) return false;
			req.session.notification = {
				type: 'danger',
				message: `Fehler beim Erstellen des Nutzers. ${err.error.message
					|| ''}`,
			};
			return res.redirect(req.header('Referer'));
		});
};

/**
 * send out problem to the sc helpdesk
 * @param service currently only used for helpdesk
 * @returns {Function}
 */
const getSendHelper = service => function send(req, res, next) {
	api(req)
		.get(`/${service}/${req.params.id}`)
		.then((data) => {
			const user = res.locals.currentUser;

			api(req)
				.post('/helpdesk', {
					json: {
						type: 'contactHPI',
						subject: data.subject,
						category: data.category,
						role: '',
						desire: '',
						benefit: '',
						acceptanceCriteria: '',
						currentState: data.currentState,
						targetState: data.targetState,
						notes: data.notes,
						schoolName: res.locals.currentSchoolData.name,
						userId: user._id,
						email: user.email ? user.email : '',
						schoolId: res.locals.currentSchoolData._id,
						cloud: res.locals.theme.title,
					},
				})
				.then(() => {
					api(req).patch(`/${service}/${req.params.id}`, {
						json: {
							state: 'submitted',
							order: 1,
						},
					});
				})
				.catch((err) => {
					res.status(err.statusCode || 500).send(err);
				});
			res.redirect(req.get('Referrer'));
		});
};

const getCSVImportHandler = () => async function handler(req, res, next) {
	const buildMessage = (stats) => {
		const numberOfUsers = stats.users.successful + stats.users.failed;
		return (
			`${stats.users.successful} von ${numberOfUsers} `
			+ `Nutzer${numberOfUsers > 1 ? 'n' : ''} erfolgreich importiert `
			+ `(${stats.users.created} erstellt, ${stats.users.updated} aktualisiert).`
		);
	};
	const buildErrorMessage = (stats) => {
		const whitelist = ['file', 'user', 'invitation', 'class'];
		let errorText = stats.errors
			.filter(err => whitelist.includes(err.type))
			.map(err => `${err.entity} (${err.message})`)
			.join(', ');
		if (errorText === '') {
			errorText = 'Es ist ein unbekannter Fehler beim Importieren aufgetreten.';
		}
		return errorText;
	};
	try {
		const csvData = decoder.write(req.file.buffer);
		const [stats] = await api(req).post('/sync/', {
			qs: {
				target: 'csv',
				school: req.body.schoolId,
				role: req.body.roles[0],
				sendEmails: Boolean(req.body.sendRegistration),
				schoolYear: req.body.schoolYear,
			},
			json: {
				data: csvData,
			},
		});
		let messageType = 'success';
		let message = buildMessage(stats);
		if (!stats.success) {
			messageType = 'warning';
			message += ` Fehler:\n\n${buildErrorMessage(stats)}`;
		}
		req.session.notification = {
			type: messageType,
			message,
		};
		res.redirect(req.header('Referer'));
		return;
	} catch (err) {
		req.session.notification = {
			type: 'danger',
			message:
				'Import fehlgeschlagen. Bitte überprüfe deine Eingabedaten und versuche es erneut.',
		};
		res.redirect(req.header('Referer'));
	}
};

const dictionary = {
	open: 'Offen',
	closed: 'Geschlossen',
	submitted: 'Gesendet',
	dashboard: 'Übersicht',
	courses: 'Kurse',
	classes: 'Klassen',
	teams: 'Teams',
	homework: 'Aufgaben',
	files: 'Dateien',
	content: 'Materialien',
	administration: 'Verwaltung',
	login_registration: 'Anmeldung/Registrierung',
	other: 'Sonstiges',
	technical_problems: 'Techn. Probleme',
};

const getUpdateHandler = service => function updateHandler(req, res, next) {
	api(req)
		.patch(`/${service}/${req.params.id}`, {
			// TODO: sanitize
			json: req.body,
		})
		.then((data) => {
			createEventsForData(data, service, req, res).then(() => {
				res.redirect(cutEditOffUrl(req.header('Referer')));
			});
		})
		.catch((err) => {
			next(err);
		});
};

const getDetailHandler = service => function detailHandler(req, res, next) {
	api(req)
		.get(`/${service}/${req.params.id}`)
		.then((data) => {
			res.json(mapEventProps(data, service));
		})
		.catch((err) => {
			next(err);
		});
};

const getDeleteHandler = (service, redirectUrl) => function deleteHandler(req, res, next) {
	api(req)
		.delete(`/${service}/${req.params.id}`)
		.then(() => {
			if (redirectUrl) {
				res.redirect(redirectUrl);
			} else {
				res.redirect(req.header('Referer'));
			}
		})
		.catch((err) => {
			next(err);
		});
};

const getDeleteAccountForUserHandler = (req, res, next) => {
	api(req)
		.get('/accounts/', {
			qs: {
				userId: req.params.id,
			},
		})
		.then((accounts) => {
			// if no account find, user isn't fully registered
			if (!accounts || accounts.length <= 0) {
				next();
				return;
			}

			// for now there is only one account for a given user
			const account = accounts[0];
			api(req)
				.delete(`/accounts/${account._id}`)
				.then(() => {
					next();
				});
		})
		.catch((err) => {
			next(err);
		});
};

const removeSystemFromSchoolHandler = (req, res, next) => {
	api(req)
		.patch(`/schools/${res.locals.currentSchool}`, {
			json: {
				$pull: {
					systems: req.params.id,
				},
			},
		})
		.then(() => {
			next();
		})
		.catch((err) => {
			next(err);
		});
};

const createSystemHandler = (req, res, next) => {
	api(req)
		.post('/systems/', { json: req.body })
		.then((system) => {
			api(req)
				.patch(`/schools/${req.body.schoolId}`, {
					json: {
						$push: {
							systems: system._id,
						},
					},
				})
				.then(() => {
					res.redirect('/administration/school');
				})
				.catch((err) => {
					next(err);
				});
		});
};

const getStorageProviders = res => [
	{
		label: res.locals.theme.short_title,
		value: 'awsS3',
	},
];

const getSSOTypes = () => [
	{ label: 'Moodle', value: 'moodle' },
	{ label: 'itslearning', value: 'itslearning' },
	{ label: 'IServ', value: 'iserv' },
	{ label: 'LDAP', value: 'ldap', hidden: true },
];

const createBucket = (req, res, next) => {
	if (req.body.fileStorageType) {
		Promise.all([
			api(req).post('/fileStorage/bucket', {
				json: {
					fileStorageType: req.body.fileStorageType,
					schoolId: req.params.id,
				},
			}),
			api(req).patch(`/schools/${req.params.id}`, {
				json: req.body,
			}),
		])
			.then(() => {
				res.redirect(req.header('Referer'));
			})
			.catch((err) => {
				next(err);
			});
	}
};

const returnAdminPrefix = (roles) => {
	let prefix;
	// eslint-disable-next-line array-callback-return
	roles.map((role) => {
		// eslint-disable-next-line no-unused-expressions
		role.name === 'teacher'
			? (prefix = 'Verwaltung: ')
			: (prefix = 'Administration: ');
	});
	return prefix;
};

// needed??
// eslint-disable-next-line no-unused-vars
const getClasses = (user, classes, teacher) => {
	let userClasses = '';

	if (teacher) {
		// eslint-disable-next-line array-callback-return
		classes.data.map((uClass) => {
			if (uClass.teacherIds.includes(user._id)) {
				if (userClasses !== '') {
					userClasses = `${userClasses} , ${uClass.displayName}` || '';
				} else {
					userClasses = uClass.displayName || '';
				}
			}
		});
	} else {
		// eslint-disable-next-line array-callback-return
		classes.data.map((uClass) => {
			if (uClass.userIds.includes(user._id)) {
				if (userClasses !== '') {
					userClasses = `${userClasses} , ${uClass.displayName}` || '';
				} else {
					userClasses = uClass.displayName || '';
				}
			}
		});
	}

	return userClasses;
};

// with userId to accountId
const userIdtoAccountIdUpdate = service => function useIdtoAccountId(req, res, next) {
	api(req)
		.get(`/${service}/?userId=${req.params.id}`)
		.then((users) => {
			api(req)
				.patch(`/${service}/${users[0]._id}`, {
					json: req.body,
				})
				.then(() => {
					req.session.notification = {
						type: 'success',
						message: 'Änderungen erfolgreich gespeichert.',
					};
					res.redirect(req.header('Referer'));
				})
				.catch((err) => {
					next(err);
				});
		})
		.catch((err) => {
			next(err);
		});
};

const userFilterSettings = (defaultOrder, isTeacherPage = false) => [
	{
		type: 'sort',
		title: 'Sortierung',
		displayTemplate: 'Sortieren nach: %1',
		options: [
			['firstName', 'Vorname'],
			['lastName', 'Nachname'],
			['email', 'E-Mail-Adresse'],
			['createdAt', 'Erstelldatum'],
		],
		defaultSelection: defaultOrder || 'firstName',
		defaultOrder: 'DESC',
	},
	{
		type: 'limit',
		title: 'Einträge pro Seite',
		displayTemplate: 'Einträge pro Seite: %1',
		options: [25, 50, 100],
		defaultSelection: 25,
	},
	{
		type: 'select',
		title: 'Einverständniserklärung Status',
		displayTemplate: 'Status: %1',
		property: 'consentStatus',
		multiple: true,
		expanded: true,
		options: isTeacherPage
			? [
				['missing', 'Keine Einverständniserklärung vorhanden'],
				['ok', 'Alle Zustimmungen vorhanden'],
			]
			: [
				['missing', 'Keine Einverständniserklärung vorhanden'],
				[
					'parentsAgreed',
					'Eltern haben zugestimmt (oder Schüler ist über 16)',
				],
				['ok', 'Alle Zustimmungen vorhanden'],
			],
	},
];

const parseDate = (input) => {
	const parts = input.match(/(\d+)/g);
	return new Date(parts[2], parts[1] - 1, parts[0]);
};

const generatePassword = () => {
	const words = ['auto', 'baum', 'bein', 'blumen', 'flocke', 'frosch', 'halsband', 'hand', 'haus', 'herr', 'horn',
		'kind', 'kleid', 'kobra', 'komet', 'konzert', 'kopf', 'kugel', 'puppe', 'rauch', 'raupe', 'regenbogen', 'schuh',
		'seele', 'spatz', 'taktisch', 'traum', 'trommel', 'wolke'];
	return words[Math.floor((Math.random() * words.length))] + Math.floor((Math.random() * 98) + 1).toString();
};

const skipRegistration = (req, res, next) => {
	const userid = req.params.id;
	const {
		passwd,
		// eslint-disable-next-line camelcase
		parent_privacyConsent,
		// eslint-disable-next-line camelcase
		parent_termsOfUseConsent,
		privacyConsent,
		termsOfUseConsent,
		birthday,
	} = req.body;
	const parsedDate = parseDate(birthday).toISOString();
	api(req).post(`/users/${userid}/skipregistration`, {
		json: {
			password: passwd,
			parent_privacyConsent,
			parent_termsOfUseConsent,
			privacyConsent,
			termsOfUseConsent,
			birthday: parsedDate,
		},
	}).then(() => {
		res.render('administration/users_registrationcomplete', {
			title: 'Einverständnis erfolgreich erklärt',
			submitLabel: 'Zurück',
			users: [
				{
					email: req.body.email,
					password: req.body.passwd,
					fullname: `${req.body.firstName} ${req.body.lastName}`,
				},
			],
			single: true,
			linktarget: '/administration/students',
		});
	}).catch(() => {
		req.session.notification = {
			type: 'danger',
			message: 'Einrichtung fehlgeschlagen. Bitte versuche es später noch einmal. ',
		};
		res.redirect(req.header('Referer'));
	});
};

const getConsentStatusIcon = (consentStatus, isTeacher = false) => {
	const check = '<i class="fa fa-check consent-status"></i>';
	const times = '<i class="fa fa-times consent-status"></i>'; // is red x
	const doubleCheck = '<i class="fa fa-check consent-status double-check"></i>'
		+ '<i class="fa fa-check consent-status double-check"></i>';

	switch (consentStatus) {
		case 'missing':
			return times;
		case 'parentsAgreed':
			return check;
		case 'ok':
			return isTeacher ? check : doubleCheck;
		default:
			return times;
	}
};

// teacher admin permissions
router.all(
	'/',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'TEACHER_CREATE'], 'or'),
	(req, res, next) => {
		const title = returnAdminPrefix(res.locals.currentUser.roles);
		res.render('administration/dashboard', {
			title: `${title}Allgemein`,
		});
	},
);

const getTeacherUpdateHandler = () => async function teacherUpdateHandler(req, res, next) {
	const promises = [
		api(req).patch(`/users/${req.params.id}`, { json: req.body }),
	]; // TODO: sanitize

	// extract consent
	if (req.body.form) {
		const consent = {
			_id: req.body.consentId,
			userConsent: {
				form: req.body.form || 'analog',
				privacyConsent: req.body.privacyConsent || false,
				termsOfUseConsent: req.body.termsOfUseConsent || false,
			},
		};
		if (consent._id) {
			// update exisiting consent
			promises.push(
				api(req).patch(`/consents/${consent._id}`, { json: consent }),
			);
		} else {
			// create new consent entry
			delete consent._id;
			consent.userId = req.params.id;
			promises.push(api(req).post('/consents/', { json: consent }));
		}
	}

	// extract class information
	if (req.body.classes && !Array.isArray(req.body.classes)) {
		req.body.classes = [req.body.classes];
	}
	const usersClasses = (await api(req).get('/classes', {
		qs: {
			teacherIds: req.params.id,
		},
	})).data.map(c => c._id);
	const addedClasses = (req.body.classes || []).filter(
		i => !usersClasses.includes(i),
	);
	const removedClasses = usersClasses.filter(
		i => !(req.body.classes || []).includes(i),
	);
	addedClasses.forEach((addClass) => {
		promises.push(
			api(req).patch(`/classes/${addClass}`, {
				json: { $push: { teacherIds: req.params.id } },
			}),
		);
	});
	removedClasses.forEach((removeClass) => {
		promises.push(
			api(req).patch(`/classes/${removeClass}`, {
				json: { $pull: { teacherIds: req.params.id } },
			}),
		);
	});

	// do all db requests
	Promise.all(promises)
		.then(() => {
			res.redirect(req.body.referrer);
		})
		.catch((err) => {
			next(err);
		});
};

router.post(
	'/teachers/',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'TEACHER_CREATE'], 'or'),
	generateRegistrationLink({ role: 'teacher', patchUser: true, save: true }),
	getUserCreateHandler(),
);
router.post(
	'/teachers/import/',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'TEACHER_CREATE'], 'or'),
	upload.single('csvFile'),
	getCSVImportHandler(),
);
router.post(
	'/teachers/:id',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'TEACHER_CREATE'], 'or'),
	getTeacherUpdateHandler(),
);
router.patch(
	'/teachers/:id/pw',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'TEACHER_CREATE'], 'or'),
	userIdtoAccountIdUpdate('accounts'),
);
router.get(
	'/teachers/:id',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'TEACHER_CREATE'], 'or'),
	getDetailHandler('users'),
);
router.delete(
	'/teachers/:id',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'TEACHER_CREATE'], 'or'),
	getDeleteAccountForUserHandler,
	getDeleteHandler('users', '/administration/teachers'),
);

router.all(
	'/teachers',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'TEACHER_CREATE'], 'or'),
	(req, res, next) => {
		const tempOrgQuery = (req.query || {}).filterQuery;
		const filterQueryString = tempOrgQuery
			? `&filterQuery=${decodeURI(tempOrgQuery)}`
			: '';

		let itemsPerPage = 25;
		let filterQuery = {};
		if (tempOrgQuery) {
			filterQuery = JSON.parse(decodeURI(req.query.filterQuery));
			if (filterQuery.$limit) {
				itemsPerPage = filterQuery.$limit;
			}
		}

		const currentPage = parseInt(req.query.p, 10) || 1;
		const title = returnAdminPrefix(res.locals.currentUser.roles);

		let query = {
			$limit: itemsPerPage,
			$skip: itemsPerPage * (currentPage - 1),
		};
		query = Object.assign(query, filterQuery);

		api(req)
			.get('users/admin/teachers', {
				qs: query,
			})
			.then(async (teachersResponse) => {
				const users = teachersResponse.data;
				const years = getSelectableYears(res.locals.currentSchoolData);
				const head = ['Vorname', 'Nachname', 'E-Mail-Adresse', 'Klasse(n)'];
				if (
					res.locals.currentUser.roles
						.map(role => role.name)
						.includes('administrator')
				) {
					head.push('Erstellt am');
					head.push('Einverständnis');
					head.push('');
				}
				const body = users.map((user) => {
					const statusIcon = getConsentStatusIcon(
						user.consent.consentStatus,
						true,
					);
					const icon = `<p class="text-center m-0">${statusIcon}</p>`;
					const row = [
						user.firstName || '',
						user.lastName || '',
						user.email || '',
						user.classesString || '',
					];
					if (
						res.locals.currentUser.roles
							.map(role => role.name)
							.includes('administrator')
					) {
						row.push(moment(user.createdAt).format('DD.MM.YYYY'));
						row.push({
							useHTML: true,
							content: icon,
						});
						row.push([
							{
								link: `/administration/teachers/${user._id}/edit`,
								title: 'Nutzer bearbeiten',
								icon: 'edit',
							},
						]);
					}
					return row;
				});

				const pagination = {
					currentPage,
					numPages: Math.ceil(teachersResponse.total / itemsPerPage),
					baseUrl: `/administration/teachers/?p={{page}}${filterQueryString}`,
				};

				res.render('administration/teachers', {
					title: `${title}Lehrer`,
					head,
					body,
					pagination,
					filterSettings: JSON.stringify(userFilterSettings('lastName', true)),
					schoolUsesLdap: res.locals.currentSchoolData.ldapSchoolIdentifier,
					schoolCurrentYear: res.locals.currentSchoolData.currentYear,
					years,
				});
			});
	},
);

router.get(
	'/teachers/:id/edit',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'TEACHER_CREATE'], 'or'),
	(req, res, next) => {
		const userPromise = api(req).get(`/users/${req.params.id}`);
		const consentPromise = getSelectOptions(req, 'consents', {
			userId: req.params.id,
		});
		const classesPromise = getSelectOptions(req, 'classes', {
			$populate: ['year'],
			$sort: 'displayName',
		});
		const accountPromise = api(req).get('/accounts/', {
			qs: { userId: req.params.id },
		});

		Promise.all([
			userPromise,
			consentPromise,
			classesPromise,
			accountPromise,
		]).then(([user, _consent, _classes, _account]) => {
			const consent = _consent[0] || {};
			const account = _account[0];
			const hidePwChangeButton = !account;

			const classes = _classes.map((c) => {
				c.selected = c.teacherIds.includes(user._id);
				return c;
			});
			res.render('administration/users_edit', {
				title: 'Lehrer bearbeiten',
				action: `/administration/teachers/${user._id}`,
				submitLabel: 'Speichern',
				closeLabel: 'Abbrechen',
				user,
				consentStatusIcon: getConsentStatusIcon(consent.consentStatus, true),
				consent,
				classes,
				editTeacher: true,
				hidePwChangeButton,
				isAdmin: res.locals.currentUser.permissions.includes('ADMIN_VIEW'),
				schoolUsesLdap: res.locals.currentSchoolData.ldapSchoolIdentifier,
				referrer: req.header('Referer'),
			});
		});
	},
);

/*
    STUDENTS
*/

const getStudentUpdateHandler = () => async function studentUpdateHandler(req, res, next) {
	if (req.body.birthday) {
		const birthday = req.body.birthday.split('.');
		req.body.birthday = `${birthday[2]}-${birthday[1]}-${
			birthday[0]
		}T00:00:00Z`;
	}

	const promises = [];

	// Consents
	if (req.body.student_form || req.body.parent_form) {
		const newConsent = {};
		if (req.body.student_form) {
			newConsent.userConsent = {
				form: req.body.student_form || 'analog',
				privacyConsent: req.body.student_privacyConsent === 'true',
				termsOfUseConsent: req.body.student_termsOfUseConsent === 'true',
			};
		}
		if (req.body.parent_form) {
			newConsent.parentConsents = [];
			newConsent.parentConsents[0] = {
				form: req.body.parent_form || 'analog',
				privacyConsent: req.body.parent_privacyConsent === 'true',
				termsOfUseConsent: req.body.parent_termsOfUseConsent === 'true',
			};
		}
		if (req.body.student_consentId) {
			// update exisiting consent
			promises.push(
				api(req).patch(`/consents/${req.body.student_consentId}`, {
					json: newConsent,
				}),
			);
		} else {
			// create new consent entry
			newConsent.userId = req.params.id;
			promises.push(api(req).post('/consents/', { json: newConsent }));
		}
	}

	// remove all consent infos from user post
	Object.keys(req.body).forEach((key) => {
		if (key.startsWith('parent_') || key.startsWith('student_')) {
			delete req.body[key];
		}
	});

	promises.push(
		api(req).patch(`/users/${req.params.id}`, { json: req.body }),
	); // TODO: sanitize

	Promise.all(promises)
		.then(() => {
			res.redirect(req.body.referrer);
		})
		.catch((err) => {
			next(err);
		});
};

router.post(
	'/students/',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'STUDENT_CREATE'], 'or'),
	generateRegistrationLink({ role: 'student', patchUser: true, save: true }),
	getUserCreateHandler(),
);
router.post(
	'/students/import/',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'STUDENT_CREATE'], 'or'),
	upload.single('csvFile'),
	getCSVImportHandler(),
);
router.patch(
	'/students/:id/pw',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'STUDENT_CREATE'], 'or'),
	userIdtoAccountIdUpdate('accounts'),
);
router.post(
	'/students/:id',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'STUDENT_CREATE'], 'or'),
	getStudentUpdateHandler(),
);
router.get(
	'/students/:id',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'STUDENT_CREATE'], 'or'),
	getDetailHandler('users'),
);
router.delete(
	'/students/:id',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'STUDENT_CREATE'], 'or'),
	getDeleteAccountForUserHandler,
	getDeleteHandler('users', '/administration/students'),
);
router.post(
	'/students/:id/skipregistration/',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'STUDENT_CREATE'], 'or'),
	skipRegistration,
);
router.get(
	'/students/:id/skipregistration',
	permissionsHelper.permissionsChecker('STUDENT_SKIP_REGISTRATION'),
	(req, res, next) => {
		api(req).get(`/users/${req.params.id}`)
			.then((user) => {
				res.render('administration/users_skipregistration', {
					title: 'Einverständnis erklären',
					action: `/administration/students/${user._id}/skipregistration`,
					submitLabel: 'Einverständnis erklären',
					closeLabel: 'Abbrechen',
					user,
					password: generatePassword(),
					referrer: req.header('Referer'),
				});
			})
			.catch((err) => {
				next(err);
			});
	},
);

router.all(
	'/students',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'STUDENT_CREATE'], 'or'),
	async (req, res, next) => {
		const tempOrgQuery = (req.query || {}).filterQuery;
		const filterQueryString = tempOrgQuery
			? `&filterQuery=${decodeURI(tempOrgQuery)}`
			: '';

		let itemsPerPage = 25;
		let filterQuery = {};
		if (tempOrgQuery) {
			filterQuery = JSON.parse(decodeURI(req.query.filterQuery));
			if (filterQuery.$limit) {
				itemsPerPage = filterQuery.$limit;
			}
		}

		const currentPage = parseInt(req.query.p, 10) || 1;

		const canSkip = permissionsHelper.userHasPermission(res.locals.currentUser, 'STUDENT_SKIP_REGISTRATION');
		// const title = returnAdminPrefix(res.locals.currentUser.roles);

		let query = {
			$limit: itemsPerPage,
			$skip: itemsPerPage * (currentPage - 1),
		};
		query = Object.assign(query, filterQuery);
		api(req)
			.get('/users/admin/students', {
				qs: query,
			})
			.then(async (studentsResponse) => {
				const users = studentsResponse.data;
				const years = getSelectableYears(res.locals.currentSchoolData);
				const title = `${returnAdminPrefix(
					res.locals.currentUser.roles,
				)}Schüler`;
				let studentsWithoutConsentCount = 0;
				const head = [
					'Vorname',
					'Nachname',
					'E-Mail-Adresse',
					'Klasse(n)',
					'Erstellt am',
					'Einverständnis',
					'',
				];

				const body = users.map((user) => {
					const icon = getConsentStatusIcon(user.consent.consentStatus);
					const userRow = [
						{
							link: `/administration/students/${user._id}/edit`,
							title: 'Nutzer bearbeiten',
							icon: 'edit',
						},
					];
					if (user.importHash && canSkip) {
						userRow.push({
							link: `/administration/students/${user._id}/skipregistration`,
							title: 'Einverständnis erklären',
							icon: 'check-square-o',
						});
					}
					if (user.consent.consentStatus === 'missing'
						|| user.consent.consentStatus === 'default') {
						studentsWithoutConsentCount += 1;
					}
					return [
						user.firstName || '',
						user.lastName || '',
						user.email || '',
						user.classes.join(', ') || '',
						moment(user.createdAt).format('DD.MM.YYYY'),
						{
							useHTML: true,
							content: `<p class="text-center m-0">${icon}</p>`,
						},
						userRow,
					];
				});

				const pagination = {
					currentPage,
					numPages: Math.ceil(studentsResponse.total / itemsPerPage),
					baseUrl: `/administration/students/?p={{page}}${filterQueryString}`,
				};

				try {
					res.render('administration/students', {
						title,
						head,
						body,
						pagination,
						filterSettings: JSON.stringify(userFilterSettings()),
						schoolUsesLdap: res.locals.currentSchoolData.ldapSchoolIdentifier,
						schoolCurrentYear: res.locals.currentSchoolData.currentYear,
						studentsWithoutConsentCount,
						allStudentsCount: users.length,
						years,
					});
				} catch (err) {
					logger.warn(
						'Can not render /administration/students in router.all("/students")',
					);
					next(err);
				}
			})
			.catch((err) => {
				logger.error(`Can not fetch data from /users/admin/students in router.all("/students")
			| message: ${err.message} | code: ${err.code}.`);
				return [];
			});
	},
);

const getUsersWithoutConsent = async (req, roleName, classId) => {
	const role = await api(req).get('/roles', {
		qs: { name: roleName },
		$limit: false,
	});
	const qs = { roles: role.data[0]._id, $limit: false };
	let users = [];

	if (classId) {
		const klass = await api(req).get(`/classes/${classId}`, {
			qs: {
				$populate: ['teacherIds', 'userIds'],
			},
		});
		users = klass.userIds.concat(klass.teacherIds);
	} else {
		users = (await api(req).get('/users', { qs, $limit: false })).data;
	}

	let consents = [];
	const batchSize = 50;
	let slice = 0;
	while (slice * batchSize <= users.length) {
		consents = consents.concat(
			(await api(req).get('/consents', {
				qs: {
					userId: {
						$in: users
							.slice(slice * batchSize, (slice + 1) * batchSize)
							.map(u => u._id),
					},
					$populate: 'userId',
					$limit: false,
				},
			})).data,
		);
		slice += 1;
	}

	const consentMissing = user => !consents.some(
		consent => consent.userId._id.toString() === user._id.toString(),
	);
	const consentIncomplete = consent => !consent.access;

	const usersWithoutConsent = users.filter(consentMissing);
	const usersWithIncompleteConsent = consents
		.filter(consentIncomplete)
		.map(c => c.userId);
	return usersWithoutConsent.concat(usersWithIncompleteConsent);
};

router.get(
	'/users-without-consent/send-email',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'STUDENT_CREATE'], 'or'),
	async (req, res, next) => {
		let usersWithoutConsent = await getUsersWithoutConsent(
			req,
			req.query.role,
			req.query.classId,
		);
		const role = req.query.role;

		usersWithoutConsent = await Promise.all(
			usersWithoutConsent.map(async (user) => {
				user.registrationLink = await generateRegistrationLink(
					{
						role,
						save: true,
						host: process.env.HOST,
						schoolId: res.locals.currentSchool,
						toHash: user.email,
						patchUser: true,
					},
					true,
				)(req, res, next);

				return Promise.resolve(user);
			}),
		);

		try {
			for (const user of usersWithoutConsent) {
				const name = user.displayName
					? user.displayName
					: `${user.firstName} ${user.lastName}`;
				const content = {
					text: `Hallo ${name},
Leider fehlt uns von dir noch die Einverständniserklärung.
Ohne diese kannst du die Schul-Cloud leider nicht nutzen.

Melde dich bitte mit deinen Daten an,
um die Einverständniserklärung zu akzeptieren um die Schul-Cloud im vollen Umfang nutzen zu können.

Gehe jetzt auf <a href="${user.registrationLink.shortLink}">${
	user.registrationLink.shortLink
}</a>, und melde dich an.`,
				};

				const json = {
					headers: {},
					email: user.email,
					subject: `Der letzte Schritt zur Aktivierung für die ${
						res.locals.theme.short_title
					}`,
					content,
				};

				await api(req).post('/mails', {
					json,
				});
			}
			res.sendStatus(200);
		} catch (err) {
			res.status(err.statusCode || 500).send(err);
		}
	},
);

router.get(
	'/users-without-consent/get-json',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'STUDENT_CREATE'], 'or'),
	async (req, res, next) => {
		const role = req.query.role;

		try {
			let usersWithoutConsent = await getUsersWithoutConsent(
				req,
				role,
				req.query.classId,
			);

			usersWithoutConsent = await Promise.all(
				usersWithoutConsent.map(async (user) => {
					user.registrationLink = await generateRegistrationLink(
						{
							role,
							save: true,
							host: process.env.HOST,
							schoolId: res.locals.currentSchool,
							toHash: user.email,
							patchUser: true,
						},
						true,
					)(req, res, next);

					return Promise.resolve(user);
				}),
			);

			res.json(usersWithoutConsent);
		} catch (err) {
			res.status(err.statusCode || 500).send(err);
		}
	},
);

router.get(
	'/students/:id/edit',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'STUDENT_CREATE'], 'or'),
	(req, res, next) => {
		const userPromise = api(req).get(`/users/${req.params.id}`);
		const consentPromise = getSelectOptions(req, 'consents', {
			userId: req.params.id,
		});
		const accountPromise = api(req).get('/accounts/', {
			qs: { userId: req.params.id },
		});
		const canSkip = permissionsHelper.userHasPermission(res.locals.currentUser, 'STUDENT_SKIP_REGISTRATION');

		Promise.all([userPromise, consentPromise, accountPromise])
			.then(([user, _consent, [account]]) => {
				const consent = _consent[0] || {};
				if (consent) {
					consent.parentConsent = (consent.parentConsents || []).length
						? consent.parentConsents[0]
						: {};
				}
				const hidePwChangeButton = !account;
				res.render('administration/users_edit', {
					title: 'Schüler bearbeiten',
					action: `/administration/students/${user._id}`,
					submitLabel: 'Speichern',
					closeLabel: 'Abbrechen',
					user,
					consentStatusIcon: getConsentStatusIcon(consent.consentStatus),
					consent,
					canSkipConsent: canSkip,
					hasImportHash: user.importHash,
					hidePwChangeButton,
					schoolUsesLdap: res.locals.currentSchoolData.ldapSchoolIdentifier,
					referrer: req.header('Referer'),
				});
			})
			.catch((err) => {
				next(err);
			});
	},
);

/*
  CLASSES
*/
const skipRegistrationClass = async (req, res, next) => {
	let {
		userids,
		birthdays,
		passwords,
		emails,
		fullnames,
	} = req.body;
	if (!(userids && birthdays && passwords && emails && fullnames)) {
		req.session.notification = {
			type: 'danger',
			message: 'Es ist ein Fehler beim Erteilen der Einverständniserklärung aufgetreten. ',
		};
		res.redirect(req.body.referrer);
		return;
	}
	// fallback if only one user is supposed to be edited
	if (typeof (birthdays) === 'string') {
		userids = [userids];
		birthdays = [birthdays];
		passwords = [passwords];
		emails = [emails];
		fullnames = [fullnames];
	}
	if (!((userids.length === birthdays.length) && (birthdays.length === passwords.length))) {
		req.session.notification = {
			type: 'danger',
			message: 'Es ist ein Fehler beim Erteilen der Einverständniserklärung aufgetreten. ',
		};
		res.redirect(req.body.referrer);
		return;
	}
	const changePromises = userids.map(async (userid, i) => {
		api(req).post(`/users/${userid}/skipregistration`, {
			json: {
				password: passwords[i],
				parent_privacyConsent: true,
				parent_termsOfUseConsent: true,
				privacyConsent: true,
				termsOfUseConsent: true,
				birthday: parseDate(birthdays[i]),
			},
		});
	});
	Promise.all(changePromises).then(() => {
		const result = userids.map((student, i) => ({
			email: emails[i],
			password: passwords[i],
			fullname: fullnames[i],
		}));
		res.render('administration/users_registrationcomplete', {
			title: 'Einwilligungen erfolgreich erteilt',
			submitLabel: 'Zurück',
			users: result,
			linktarget: '/administration/classes',
		});
	}).catch(() => {
		req.session.notification = {
			type: 'danger',
			message: 'Es ist ein Fehler beim Erteilen der Einverständniserklärung aufgetreten. ',
		};
		res.redirect(req.body.referrer);
	});
};

const renderClassEdit = (req, res, next, edit) => {
	api(req)
		.get('/classes/')
		.then(() => {
			const promises = [
				getSelectOptions(req, 'users', {
					roles: ['teacher', 'demoTeacher'],
					$limit: false,
				}), // teachers
				getSelectOptions(req, 'gradeLevels'),
			];
			if (edit) {
				promises.push(api(req).get(`/classes/${req.params.classId}`));
			}

			Promise.all(promises).then(
				([teachers, gradeLevels, currentClass]) => {
					const schoolyears = getSelectableYears(res.locals.currentSchoolData);
					gradeLevels.sort(
						(a, b) => parseInt(a.name, 10) - parseInt(b.name, 10),
					);

					const isAdmin = res.locals.currentUser.permissions.includes(
						'ADMIN_VIEW',
					);
					if (!isAdmin) {
						// preselect current teacher when creating new class
						// and the current user isn't a admin (teacher)
						teachers.forEach((t) => {
							if (
								JSON.stringify(t._id)
								=== JSON.stringify(res.locals.currentUser._id)
							) {
								t.selected = true;
							}
						});
					}
					let isCustom = false;
					if (currentClass) {
						// preselect already selected teachers
						teachers.forEach((t) => {
							if ((currentClass.teacherIds || {}).includes(t._id)) {
								t.selected = true;
							}
						});
						gradeLevels.forEach((g) => {
							// eslint-disable-next-line eqeqeq
							if ((currentClass.gradeLevel || {})._id == g._id) {
								g.selected = true;
							}
						});
						schoolyears.forEach((schoolyear) => {
							if (currentClass.year === schoolyear._id) {
								schoolyear.selected = true;
							}
						});
						if (currentClass.nameFormat === 'static') {
							isCustom = true;
							currentClass.customName = currentClass.name;
							if (currentClass.year) {
								currentClass.keepYear = true;
							}
						} else if (currentClass.nameFormat === 'gradeLevel+name') {
							currentClass.classsuffix = currentClass.name;
						}
					}

					res.render('administration/classes-edit', {
						title: `${
							edit
								? `Klasse '${currentClass.displayName}' bearbeiten`
								: 'Erstelle eine neue Klasse'
						}`,
						edit,
						schoolyears,
						teachers,
						class: currentClass,
						gradeLevels,
						isCustom,
						referrer: '/administration/classes/',
					});
				},
			);
		})
		.catch((err) => {
			next(err);
		});
};
const getClassOverview = (req, res, next) => {
	const query = {
		$limit: 1000,
	};
	if (req.query.yearId && req.query.yearId.length > 0) {
		query.year = req.query.yearId;
	}
	api(req)
		.get('/classes', {
			qs: query,
		})
		.then((data) => {
			res.json(data);
		})
		.catch((err) => {
			next(err);
		});
};
router.get(
	'/classes/create',
	permissionsHelper.permissionsChecker(
		['ADMIN_VIEW', 'USERGROUP_CREATE'],
		'or',
	),
	(req, res, next) => {
		renderClassEdit(req, res, next, false);
	},
);
router.get(
	'/classes/students',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'USERGROUP_EDIT'], 'or'),
	(req, res, next) => {
		const classIds = JSON.parse(req.query.classes);
		api(req)
			.get('/classes/', {
				qs: {
					$populate: ['userIds'],
					_id: {
						$in: classIds,
					},
				},
			})
			.then((classes) => {
				const students = classes.data
					.map(c => c.userIds)
					// eslint-disable-next-line no-shadow
					.reduce((flat, next) => flat.concat(next), []);
				res.json(students);
			});
	},
);
router.get(
	'/classes/json',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'USERGROUP_EDIT'], 'or'),
	getClassOverview,
);
router.get(
	'/classes/:classId/edit',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'USERGROUP_EDIT'], 'or'),
	(req, res, next) => {
		renderClassEdit(req, res, next, true);
	},
);
router.get('/classes/:id', getDetailHandler('classes'));
router.patch(
	'/classes/:id',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'USERGROUP_EDIT'], 'or'),
	mapEmptyClassProps,
	getUpdateHandler('classes'),
);
router.delete(
	'/classes/:id',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'USERGROUP_EDIT'], 'or'),
	getDeleteHandler('classes'),
);

router.get(
	'/classes/:classId/manage',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'USERGROUP_EDIT'], 'or'),
	(req, res, next) => {
		api(req)
			.get(`/classes/${req.params.classId}`, {
				qs: { $populate: ['teacherIds', 'substitutionIds', 'userIds'] },
			})
			.then((currentClass) => {
				const classesPromise = getSelectOptions(req, 'classes', {
					$limit: false,
				}); // TODO limit classes to scope (year before, current and without year)
				const teachersPromise = getSelectOptions(req, 'users', {
					roles: ['teacher', 'demoTeacher'],
					$sort: 'lastName',
					$limit: false,
				});
				const studentsPromise = getSelectOptions(req, 'users', {
					roles: ['student', 'demoStudent'],
					$sort: 'lastName',
					$limit: false,
				});
				const yearsPromise = getSelectOptions(req, 'years', { $limit: false });

				const usersWithConsentsPromise = getUsersWithoutConsent(req, 'student', currentClass._id);

				Promise.all([
					classesPromise,
					teachersPromise,
					studentsPromise,
					yearsPromise,
					usersWithConsentsPromise,
				]).then(([classes, teachers, students, schoolyears, usersWithoutConsent]) => {
					const isAdmin = res.locals.currentUser.permissions.includes(
						'ADMIN_VIEW',
					);
					if (!isAdmin) {
						// preselect current teacher when creating new class
						// and the current user isn't a admin (teacher)
						teachers.forEach((t) => {
							if (
								JSON.stringify(t._id)
								=== JSON.stringify(res.locals.currentUser._id)
							) {
								t.selected = true;
							}
						});
					}
					// preselect current teacher when creating new class

					const teacherIds = currentClass.teacherIds.map(t => t._id);
					teachers.forEach((t) => {
						if (teacherIds.includes(t._id)) {
							t.selected = true;
						}
					});
					const studentIds = currentClass.userIds.map(t => t._id);
					students.forEach((s) => {
						if (studentIds.includes(s._id)) {
							s.selected = true;
						}
					});

					// importHash exists --> not signed up
					usersWithoutConsent = usersWithoutConsent.filter((obj) => {
						if (obj.importHash) return true;
						return false;
					});

					res.render('administration/classes-manage', {
						title: `Klasse '${currentClass.displayName}' verwalten `,
						class: currentClass,
						classes,
						teachers,
						students,
						schoolUsesLdap: res.locals.currentSchoolData.ldapSchoolIdentifier,
						schoolyears,
						notes: [
							{
								title: 'Deine Schüler sind unter 16 Jahre alt?',
								content: `Gib den Registrierungslink zunächst an die Eltern weiter.
                Diese legen die Schülerdaten an und erklären elektronisch ihr Einverständnis.
                Der Schüler ist dann in der ${res.locals.theme.short_title}
                registriert und du siehst ihn in deiner Klassenliste. Der Schüler kann sich mit seiner E-Mail-Adresse
                und dem individuellen Initial-Passwort einloggen.
                Nach dem ersten Login muss jeder Schüler sein Passwort ändern.
                Ist der Schüler über 14 Jahre alt, muss er zusätzlich selbst elektronisch sein Einverständnis erklären,
                damit er die ${res.locals.theme.short_title} nutzen kann.`,
							},
							{
								title: 'Deine Schüler sind mindestens 16 Jahre alt?',
								content:
									'Gib den Registrierungslink direkt an den Schüler weiter.'
									+ 'Die Schritte für die Eltern entfallen automatisch.',
							},
							/* { // TODO - Feature not implemented
                            "title":"Deine Schüler sind in der Schülerliste rot?",
                            "content": `Sie sind vom Administrator bereits angelegt
                            (z.B. durch Import aus Schüler-Verwaltungs-Software),
                            aber es fehlen noch ihre Einverständniserklärungen.
                            Lade die Schüler deiner Klasse und deren Eltern ein, ihr Einverständnis zur Nutzung
                            der ${res.locals.theme.short_title} elektronisch abzugeben.
                            Bereits erfasste Schülerdaten werden beim Registrierungsprozess
                            automatisch gefunden und ergänzt.`
                        },
                        { // TODO - Not implemented yet
                            "title":"Nutzernamen herausfinden",
                            "content":"Lorem Amet ad in officia fugiat n
                            isi anim magna tempor laborum in sit esse nostrud consequat."
                        }, */
							{
								title: 'Passwort ändern',
								content:
									// eslint-disable-next-line max-len
									'Beim ersten Login muss der Schüler sein Passwort ändern. Hat er eine E-Mail-Adresse angegeben, kann er sich das geänderte Passwort zusenden lassen oder sich bei Verlust ein neues Passwort generieren. Alternativ kannst du im Bereich Verwaltung > Schüler hinter dem Schülernamen auf Bearbeiten klicken. Dann kann der Schüler an deinem Gerät sein Passwort neu eingeben.',
							},
						],
						referrer: '/administration/classes/',
						consentsMissing: usersWithoutConsent.length !== 0,
					});
				});
			});
	},
);

router.post(
	'/classes/:classId/manage',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'USERGROUP_EDIT'], 'or'),
	(req, res, next) => {
		const changedClass = {
			teacherIds: req.body.teacherIds || [],
			userIds: req.body.userIds || [],
		};
		api(req)
			.patch(`/classes/${req.params.classId}`, {
				// TODO: sanitize
				json: changedClass,
			})
			.then(() => {
				res.redirect(req.body.referrer);
			})
			.catch((err) => {
				next(err);
			});
	},
);


router.post(
	'/classes/:classId/skipregistration',
	permissionsHelper.permissionsChecker('STUDENT_SKIP_REGISTRATION'),
	skipRegistrationClass,
);

router.get(
	'/classes/:classId/skipregistration',
	permissionsHelper.permissionsChecker('STUDENT_SKIP_REGISTRATION'),
	async (req, res, next) => {
		let students = await getUsersWithoutConsent(req, 'student', req.params.classId);
		students = students.filter((obj) => {
			if (obj.importHash) return true;
			return false;
		});
		const passwords = students.map(() => (generatePassword()));
		const renderUsers = students.map((student, i) => ({
			fullname: `${student.firstName} ${student.lastName}`,
			id: student._id,
			email: student.email,
			birthday: student.birthday,
			password: passwords[i],
		}));
		res.render('administration/classes_skipregistration', {
			title: 'Einverständnis erklären',
			students: renderUsers,
		});
	},
);

router.post(
	'/classes/create',
	permissionsHelper.permissionsChecker(
		['ADMIN_VIEW', 'USERGROUP_CREATE'],
		'or',
	),
	(req, res, next) => {
		const newClass = {
			schoolId: req.body.schoolId,
		};
		if (req.body.classcustom) {
			newClass.name = req.body.classcustom;
			newClass.nameFormat = 'static';
			if (req.body.keepyear) {
				newClass.year = req.body.schoolyear;
			}
		} else if (req.body.classsuffix) {
			newClass.name = req.body.classsuffix;
			newClass.gradeLevel = req.body.grade;
			newClass.nameFormat = 'gradeLevel+name';
			newClass.year = req.body.schoolyear;
		}
		if (req.body.teacherIds) {
			newClass.teacherIds = req.body.teacherIds;
		}

		api(req)
			.post('/classes/', {
				// TODO: sanitize
				json: newClass,
			})
			.then((data) => {
				const isAdmin = res.locals.currentUser.permissions.includes(
					'ADMIN_VIEW',
				);
				if (isAdmin) {
					res.redirect('/administration/classes/');
				} else {
					res.redirect(`/administration/classes/${data._id}/manage`);
				}
			})
			.catch((err) => {
				next(err);
			});
	},
);

router.post(
	'/classes/:classId/edit',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'USERGROUP_EDIT'], 'or'),
	(req, res, next) => {
		const changedClass = {
			schoolId: req.body.schoolId,
		};
		if (req.body.classcustom) {
			changedClass.name = req.body.classcustom;
			changedClass.nameFormat = 'static';
			if (req.body.keepyear) {
				changedClass.year = req.body.schoolyear;
			}
		} else {
			req.body.classsuffix = req.body.classsuffix || '';
			changedClass.name = req.body.classsuffix;
			changedClass.gradeLevel = req.body.grade;
			changedClass.nameFormat = 'gradeLevel+name';
			changedClass.year = req.body.schoolyear;
		}
		if (req.body.teacherIds) {
			changedClass.teacherIds = req.body.teacherIds;
		} else {
			changedClass.teacherIds = [];
		}
		api(req)
			.patch(`/classes/${req.params.classId}`, {
				// TODO: sanitize
				json: changedClass,
			})
			.then(() => {
				res.redirect(req.body.referrer);
			})
			.catch((err) => {
				next(err);
			});
	},
);

router.patch(
	'/:classId/',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'USERGROUP_EDIT'], 'or'),
	mapEmptyClassProps,
	(req, res, next) => {
		api(req)
			.patch(`/classes/${req.params.classId}`, {
				// TODO: sanitize
				json: req.body,
			})
			.then(() => {
				res.redirect(req.header('Referer'));
			})
			.catch((err) => {
				next(err);
			});
	},
);

router.delete(
	'/:classId/',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'USERGROUP_EDIT'], 'or'),
	(req, res, next) => {
		api(req)
			.delete(`/classes/${req.params.classId}`)
			.then(() => {
				res.sendStatus(200);
			})
			.catch(() => {
				res.sendStatus(500);
			});
	},
);

const classFilterSettings = years => [
	{
		type: 'sort',
		title: 'Sortierung',
		displayTemplate: 'Sortieren nach: %1',
		options: [['displayName', 'Klasse']],
		defaultSelection: 'displayName',
		defaultOrder: 'DESC',
	},
	{
		type: 'limit',
		title: 'Einträge pro Seite',
		displayTemplate: 'Einträge pro Seite: %1',
		options: [25, 50, 100],
		defaultSelection: 25,
	},
	{
		type: 'select',
		title: 'Jahrgang',
		displayTemplate: 'Jahrgang: %1',
		property: 'year',
		multiple: true,
		expanded: true,
		options: years,
	},
];

router.all(
	'/classes',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'USERGROUP_EDIT'], 'or'),
	(req, res, next) => {
		const tempOrgQuery = (req.query || {}).filterQuery;
		const filterQueryString = tempOrgQuery
			? `&filterQuery=${escape(tempOrgQuery)}`
			: '';

		let itemsPerPage = 25;
		let filterQuery = {};
		if (tempOrgQuery) {
			filterQuery = JSON.parse(unescape(req.query.filterQuery));
			if (filterQuery.$limit) {
				itemsPerPage = filterQuery.$limit;
			}
		}
		const currentPage = parseInt(req.query.p, 10) || 1;

		let query = {
			$populate: ['teacherIds', 'year'],
			$limit: itemsPerPage,
			$skip: itemsPerPage * (currentPage - 1),
		};
		query = Object.assign(query, filterQuery);

		api(req)
			.get('/classes', {
				qs: query,
			})
			.then(async (data) => {
				const head = ['Klasse', 'Lehrer', 'Schuljahr', 'Schüler', ''];

				const body = data.data.map(item => [
					item.displayName || '',
					// eslint-disable-next-line no-shadow
					(item.teacherIds || []).map(item => item.lastName).join(', '),
					(item.year || {}).name || '',
					item.userIds.length || '0',
					// eslint-disable-next-line no-shadow
					((item, path) => [
						{
							link: `${path + item._id}/manage`,
							icon: 'users',
							title: 'Klasse verwalten',
						},
						{
							link: `${path + item._id}/edit`,
							icon: 'edit',
							title: 'Klasse bearbeiten',
						},
						{
							link: path + item._id,
							class: 'btn-delete',
							icon: 'trash-o',
							method: 'delete',
							title: 'Eintrag löschen',
						},
					])(item, '/administration/classes/'),
				]);

				const pagination = {
					currentPage,
					numPages: Math.ceil(data.total / itemsPerPage),
					baseUrl: `/administration/classes/?p={{page}}${filterQueryString}`,
				};

				const years = (await api(req).get('/years')).data.map(year => [
					year._id,
					year.name,
				]);

				res.render('administration/classes', {
					title: 'Administration: Klassen',
					head,
					body,
					pagination,
					limit: true,
					filterSettings: JSON.stringify(classFilterSettings(years)),
				});
			});
	},
);

/**
 * Set state to closed of helpdesk problem
 * @param service usually helpdesk, to disable instead of delete entry
 * @returns {Function}
 */
const getDisableHandler = service => function diasableHandler(req, res, next) {
	api(req)
		.patch(`/${service}/${req.params.id}`, {
			json: {
				state: 'closed',
				order: 2,
			},
		})
		.then(() => {
			res.redirect(req.get('Referrer'));
		});
};

/**
 * Truncates string to 25 chars
 * @param string given string to truncate
 * @returns {string}
 */
const truncate = (string) => {
	if ((string || {}).length > 25) {
		return `${string.substring(0, 25)}...`;
	}
	return string;
};

/*
    HELPDESK
*/

router.patch(
	'/helpdesk/:id',
	permissionsHelper.permissionsChecker('HELPDESK_VIEW'),
	getUpdateHandler('helpdesk'),
);
router.get(
	'/helpdesk/:id',
	permissionsHelper.permissionsChecker('HELPDESK_VIEW'),
	getDetailHandler('helpdesk'),
);
router.delete(
	'/helpdesk/:id',
	permissionsHelper.permissionsChecker('HELPDESK_VIEW'),
	getDisableHandler('helpdesk'),
);
router.post(
	'/helpdesk/:id',
	permissionsHelper.permissionsChecker('HELPDESK_VIEW'),
	getSendHelper('helpdesk'),
);
router.all(
	'/helpdesk',
	permissionsHelper.permissionsChecker('HELPDESK_VIEW'),
	(req, res, next) => {
		const itemsPerPage = req.query.limit || 10;
		const currentPage = parseInt(req.query.p, 10) || 1;
		const title = returnAdminPrefix(res.locals.currentUser.roles);

		api(req)
			.get('/helpdesk', {
				qs: {
					$limit: itemsPerPage,
					$skip: itemsPerPage * (currentPage - 1),
					$sort: req.query.sort ? req.query.sort : { order: 1 },
					schoolId: res.locals.currentSchool,
				},
			})
			.then((data) => {
				const head = [
					'Titel',
					'Ist-Zustand',
					'Soll-Zustand',
					'Kategorie',
					'Status',
					'Erstellungsdatum',
					'Anmerkungen',
					'',
				];

				const body = data.data.map(item => [
					truncate(item.subject || ''),
					truncate(item.currentState || ''),
					truncate(item.targetState || ''),
					item.category === '' ? '' : dictionary[item.category],
					dictionary[item.state],
					moment(item.createdAt).format('DD.MM.YYYY'),
					truncate(item.notes || ''),
					getTableActionsSend(item, '/administration/helpdesk/', item.state),
				]);

				let sortQuery = '';
				if (req.query.sort) {
					sortQuery = `&sort=${req.query.sort}`;
				}

				let limitQuery = '';
				if (req.query.limit) {
					limitQuery = `&limit=${req.query.limit}`;
				}

				const pagination = {
					currentPage,
					numPages: Math.ceil(data.total / itemsPerPage),
					baseUrl: `/administration/helpdesk/?p={{page}}${sortQuery}${limitQuery}`,
				};

				res.render('administration/helpdesk', {
					title: `${title}Helpdesk`,
					head,
					body,
					pagination,
					limit: true,
				});
			});
	},
);

// general admin permissions
// ONLY useable with ADMIN_VIEW !

/*
    COURSES
*/

const getCourseCreateHandler = () => function coruseCreateHandler(req, res, next) {
	api(req)
		.post('/courses/', {
			json: req.body,
		})
		.then((course) => {
			createEventsForData(course, 'courses', req, res).then(() => {
				next();
			});
		})
		.catch((err) => {
			next(err);
		});
};

const schoolUpdateHandler = async (req, res, next) => {
	const isChatAllowed = (res.locals.currentSchoolData.features || []).includes(
		'rocketChat',
	);
	if (!isChatAllowed && req.body.rocketchat === 'true') {
		// add rocketChat feature
		await api(req).patch(`/schools/${req.params.id}`, {
			json: {
				$push: {
					features: 'rocketChat',
				},
			},
		});
	} else if (isChatAllowed && req.body.rocketchat !== 'true') {
		// remove rocketChat feature
		await api(req).patch(`/schools/${req.params.id}`, {
			json: {
				$pull: {
					features: 'rocketChat',
				},
			},
		});
	}
	delete req.body.rocketchat;
	return getUpdateHandler('schools')(req, res, next);
};

router.use(permissionsHelper.permissionsChecker('ADMIN_VIEW'));
router.patch('/schools/:id', schoolUpdateHandler);
router.post('/schools/:id/bucket', createBucket);
router.post('/courses/', mapTimeProps, getCourseCreateHandler());
router.patch(
	'/courses/:id',
	mapTimeProps,
	mapEmptyCourseProps,
	deleteEventsForData('courses'),
	getUpdateHandler('courses'),
);
router.get('/courses/:id', getDetailHandler('courses'));
router.delete(
	'/courses/:id',
	getDeleteHandler('courses'),
	deleteEventsForData('courses'),
);

router.all('/courses', (req, res, next) => {
	const itemsPerPage = req.query.limit || 10;
	const currentPage = parseInt(req.query.p, 10) || 1;

	api(req)
		.get('/courses', {
			qs: {
				$populate: ['classIds', 'teacherIds'],
				$limit: itemsPerPage,
				$skip: itemsPerPage * (currentPage - 1),
				$sort: req.query.sort,
			},
		})
		.then((data) => {
			const head = ['Name', 'Klasse(n)', 'Lehrer', ''];

			const classesPromise = getSelectOptions(req, 'classes', { $limit: 1000 });
			const teachersPromise = getSelectOptions(req, 'users', {
				roles: ['teacher'],
				$limit: 1000,
			});
			const substitutionPromise = getSelectOptions(req, 'users', {
				roles: ['teacher'],
				$limit: 1000,
			});
			const studentsPromise = getSelectOptions(req, 'users', {
				roles: ['student'],
				$limit: 1000,
			});

			Promise.all([
				classesPromise,
				teachersPromise,
				substitutionPromise,
				studentsPromise,
			]).then(([classes, teachers, substitutions, students]) => {
				const body = data.data.map(item => [
					item.name,
					// eslint-disable-next-line no-shadow
					(item.classIds || []).map(item => item.displayName).join(', '),
					// eslint-disable-next-line no-shadow
					(item.teacherIds || []).map(item => item.lastName).join(', '),
					getTableActions(item, '/administration/courses/').map(
						action => action,
					),
				]);

				let sortQuery = '';
				if (req.query.sort) {
					sortQuery = `&sort=${req.query.sort}`;
				}

				let limitQuery = '';
				if (req.query.limit) {
					limitQuery = `&limit=${req.query.limit}`;
				}

				const pagination = {
					currentPage,
					numPages: Math.ceil(data.total / itemsPerPage),
					baseUrl: `/administration/courses/?p={{page}}${sortQuery}${limitQuery}`,
				};

				res.render('administration/courses', {
					title: 'Administration: Kurse',
					head,
					body,
					classes,
					teachers,
					substitutions,
					students,
					pagination,
					limit: true,
				});
			});
		});
});

/**
 *  Teams
 */

const getTeamFlags = (team) => {
	const createdAtOwnSchool = '<i class="fa fa-home team-flags" data-toggle="tooltip" '
		+ 'data-placement="top" title="An eigener Schule gegründetes Team"></i>';
	const hasMembersOfOtherSchools = '<i class="fa fa-bus team-flags" data-toggle="tooltip" '
		+ 'data-placement="top" title="Beinhaltet Schul-externe Mitglieder"></i>';
	const hasOwner = '<i class="fa fa-briefcase team-flags" data-toggle="tooltip" '
		+ 'data-placement="top" title="Team hat Eigentümer"></i>';
	const hasRocketChat = '<i class="fa fa-comments team-flags" data-toggle="tooltip" '
		+ 'data-placement="top" title="Chat ist aktiviert"></i>';

	let combined = '';

	if (team.createdAtMySchool) {
		combined += createdAtOwnSchool;
	}

	if (team.hasMembersOfOtherSchools) {
		combined += hasMembersOfOtherSchools;
	}

	if (team.ownerExist) {
		combined += hasOwner;
	}

	if (team.hasRocketChat) {
		combined += hasRocketChat;
	}

	return combined;
};

const disableStudentUpdateHandler = async function disableStudentUpdate(req, res, next) {
	// pay attention logic of checkbox is inverse to database/server naming
	const isdisableStudentCreation = (res.locals.currentSchoolData.features
		|| []).includes('disableStudentTeamCreation');
	if (!isdisableStudentCreation && req.body.enablestudentteamcreation !== 'true') {
		// add disableStudentTeamCreation feature
		await api(req).patch(`/schools/${req.params.id}`, {
			json: {
				$push: {
					features: 'disableStudentTeamCreation',
				},
			},
		});
	} else if (isdisableStudentCreation && req.body.enablestudentteamcreation === 'true') {
		// remove disableStudentTeamCreation feature
		await api(req).patch(`/schools/${req.params.id}`, {
			json: {
				$pull: {
					features: 'disableStudentTeamCreation',
				},
			},
		});
	}
	return res.redirect(cutEditOffUrl(req.header('Referer')));
};

router.patch('/teams/disablestudents/:id', disableStudentUpdateHandler);

const getTeamMembersButton = counter => `
  <div class="btn-show-members" role="button">${counter}<i class="fa fa-user team-flags"></i></div>`;

const getTeamSchoolsButton = counter => `
  <div class="btn-show-schools" role="button">${counter}<i class="fa fa-building team-flags"></i></div>`;

router.all('/teams', (req, res, next) => {
	const path = '/administration/teams/';

	const itemsPerPage = req.query.limit || 10;
	const currentPage = parseInt(req.query.p, 10) || 1;

	// TODO: mapping sort
	/*
	    'Mitglieder': 'members',
		'Schule(n)': 'schoolIds',
		'Erstellt am': 'createdAt',
	*/

	api(req)
		.get('/teams/manage/admin', {
			qs: {
				$populate: ['userIds'],
				$limit: itemsPerPage,
				$skip: itemsPerPage * (currentPage - 1),
				$sort: req.query.sort,
			},
		})
		.then((data) => {
			const head = [
				'Name',
				'Mitglieder',
				'Schule(n)',
				'Erstellt am',
				'Status*',
				'Aktionen',
			];

			const classesPromise = getSelectOptions(req, 'classes', { $limit: 1000 });
			const usersPromise = getSelectOptions(req, 'users', { $limit: 1000 });

			const roleTranslations = {
				teammember: 'Teilnehmer',
				teamexpert: 'Externer Experte',
				teamleader: 'Leiter',
				teamadministrator: 'Administrator',
				teamowner: 'Eigentümer',
			};

			Promise.all([classesPromise, usersPromise]).then(([classes, users]) => {
				const body = data.map((item) => {
					const actions = [
						{
							link: path + item._id,
							class: 'btn-write-owner',
							icon: 'envelope-o',
							title: 'Nachricht an Eigentümer senden',
							data: {
								'original-title': 'Nachricht an Eigentümer senden',
								placement: 'top',
								toggle: 'tooltip',
							},
						},
						{
							link: path + item._id,
							class: item.createdAtMySchool ? 'btn-set-teamowner' : 'disabled',
							icon: 'user-plus',
							title: 'Weiteren Eigentümer hinzufügen',
							data: {
								'original-title': 'Weiteren Eigentümer hinzufügen',
								placement: 'top',
								toggle: 'tooltip',
							},
						},
						{
							link: path + item._id,
							class: `${
								item.createdAtMySchool ? 'disabled' : 'btn-remove-members'
							}`,
							icon: 'user-times',
							data: {
								name: item.name,
								'original-title': item.createdAtMySchool
									? 'Es können nur alle Mitglieder der eigenen Schule aus dem Team entfernt werden'
									: 'Mitglieder eigener Schule aus Team entfernen',
								placement: 'top',
								toggle: 'tooltip',
							},
							title: item.createdAtMySchool
								? 'Schüler der eigenen Schule aus dem Team entfernen. Nur möglich, wenn das Team an '
								+ 'einer anderen Schule gegründet wurde und es deshalb nicht möglich ist, sich selbst '
								+ 'oder jemand anderem Admin-Rechte für das Team zuzuweisen.'
								: 'Mitglieder eigener Schule aus Team entfernen',
						},
						{
							link: path + item._id,
							class: `${
								item.createdAtMySchool ? 'btn-delete-team' : 'disabled'
							}`,
							icon: 'trash-o',
							data: {
								name: item.name,
								'original-title': item.createdAtMySchool
									? 'Team löschen'
									: 'Löschen des Teams nur bei Teams der eigenen Schule möglich',
								placement: 'top',
								toggle: 'tooltip',
							},
							// lmethod: `${item.hasMembersOfOtherSchools ? '' : 'delete'}`,
							title: item.createdAtMySchool
								? 'Team löschen'
								: 'Löschen des Teams nur bei Teams der eigenen Schule möglich',
						},
					];

					return [
						item.name,
						{
							useHTML: true,
							content: getTeamMembersButton(item.membersTotal),
						},
						{
							useHTML: true,
							content: getTeamSchoolsButton(item.schools.length),
						},
						moment(item.createdAt).format('DD.MM.YYYY'),
						{
							useHTML: true,
							content: getTeamFlags(item),
						},
						{
							payload: {
								members: item.schoolMembers.map((member) => {
									member.role = roleTranslations[member.role];
									return member;
								}),
								schools: item.schools,
							},
						},
						actions,
					];
				});

				let sortQuery = '';
				if (req.query.sort) {
					sortQuery = `&sort=${req.query.sort}`;
				}

				let limitQuery = '';
				if (req.query.limit) {
					limitQuery = `&limit=${req.query.limit}`;
				}

				const pagination = {
					currentPage,
					numPages: Math.ceil(data.total / itemsPerPage),
					baseUrl: `/administration/teams/?p={{page}}${sortQuery}${limitQuery}`,
				};

				res.render('administration/teams', {
					title: 'Administration: Teams',
					head,
					body,
					classes,
					users,
					pagination,
					school: res.locals.currentSchoolData,
					limit: true,
				});
			});
		});
});

router.get('/teams/:id', (req, res, next) => {
	api(req)
		.get(`/teams/manage/admin/${req.params.id}`)
		.then((data) => {
			res.json(mapEventProps(data));
		})
		.catch((err) => {
			next(err);
		});
});

router.post('/teams/:id', (req, res, next) => {
	api(req)
		.post('/teams/manage/admin', {
			json: {
				teamIds: req.params.id,
				message: req.body.message,
			},
		})
		.then(() => {
			res.redirect('/administration/teams/');
		})
		.catch((err) => {
			next(err);
		});
});

router.patch('/teams/:id', (req, res, next) => {
	api(req)
		.patch(`/teams/manage/admin/${req.params.id}`, {
			json: {
				userId: req.body.userId,
			},
		})
		.then(() => {
			res.redirect('/administration/teams/');
		})
		.catch((err) => {
			next(err);
		});
});

router.delete('/teams/:id', (req, res, next) => {
	api(req)
		.delete(`/teams/manage/admin/${req.params.id}`)
		.then(() => {
			res.redirect('/administration/teams/');
		})
		.catch((err) => {
			next(err);
		});
});

/*
    SCHOOL / SYSTEMS / RSS
*/

router.post('/systems/', createSystemHandler);
router.patch('/systems/:id', getUpdateHandler('systems'));
router.get('/systems/:id', getDetailHandler('systems'));
router.delete(
	'/systems/:id',
	removeSystemFromSchoolHandler,
	getDeleteHandler('systems'),
);

router.get('/rss/:id', async (req, res) => {
	const school = await api(req).patch(`/schools/${res.locals.currentSchool}`);

	const matchingRSSFeed = school.rssFeeds.find(
		feed => feed._id === req.params.id,
	);

	res.send(matchingRSSFeed);
});

router.post('/rss/', async (req, res) => {
	const school = await api(req).get(`/schools/${req.body.schoolId}`);

	if (
		school.rssFeeds
		&& school.rssFeeds.find(el => el.url === req.body.rssURL)
	) {
		return res.redirect('/administration/school');
	}

	await api(req).patch(`/schools/${req.body.schoolId}`, {
		json: {
			$push: {
				rssFeeds: { url: req.body.rssURL, description: req.body.description },
			},
		},
	});
	return res.redirect('/administration/school');
});

router.delete('/rss/:id', async (req, res) => {
	await api(req).patch(`/schools/${res.locals.currentSchool}`, {
		json: {
			$pull: {
				rssFeeds: { _id: req.params.id },
			},
		},
	});

	res.redirect('/administration/school');
});

router.use(
	'/school',
	permissionsHelper.permissionsChecker(['ADMIN_VIEW', 'TEACHER_CREATE'], 'or'),
	async (req, res) => {
		const [school, totalStorage, schoolMaintanance] = await Promise.all([
			api(req).get(`/schools/${res.locals.currentSchool}`, {
				qs: {
					$populate: ['systems', 'currentYear'],
					$sort: req.query.sort,
				},
			}),
			api(req).get('/fileStorage/total'),
			api(req).get(`/schools/${res.locals.currentSchool}/maintenance`),
		]);

		// Maintanance - Show Menu depending on the state
		const currentTime = new Date();
		const maintananceModeStarts = new Date(schoolMaintanance.currentYear.endDate);
		// Terminate school year 14 days before maintance start possible
		const twoWeeksFromStart = new Date(maintananceModeStarts.valueOf());
		twoWeeksFromStart.setDate(twoWeeksFromStart.getDate() - 14);

		let schoolMaintananceMode = 'idle';
		if (schoolMaintanance.maintenance.active) {
			schoolMaintananceMode = 'active';
		} else if (maintananceModeStarts && twoWeeksFromStart < currentTime) {
			schoolMaintananceMode = 'standby';
		}

		// SYSTEMS
		const systemsHead = ['Alias', 'Typ', ''];
		let systemsBody;
		let systems;
		let ldapAddable = true;
		if (Array.isArray(school.systems)) {
			school.systems = _.orderBy(school.systems, req.query.sort, 'desc');
			// eslint-disable-next-line eqeqeq
			systems = school.systems.filter(system => system.type != 'local');
			ldapAddable = !systems.some(e => e.type === 'ldap');

			systemsBody = systems.map((item) => {
				const name = getSSOTypes().filter(type => item.type === type.value);
				return [
					item.type === 'ldap' && item.ldapConfig.active === false
						? `${item.alias} (inaktiv)`
						: item.alias,
					name,
					getTableActions(
						item,
						'/administration/systems/',
						true,
						false,
						false,
						'systems',
					),
				];
			});
		}

		// RSS
		const rssHead = ['URL', 'Kurzbeschreibung', 'Status', ''];
		let rssBody;
		if (school.rssFeeds) {
			rssBody = school.rssFeeds.map(({
				_id, url, status, description,
			}) => [
				url,
				description,
				// eslint-disable-next-line no-nested-ternary
				status === 'success'
					? 'Aktiv'
					: status === 'error'
						? 'Fehler beim Abrufen'
						: 'In der Warteschlange',
				[
					{
						link: `/administration/rss/${_id}`,
						class: 'btn-delete--rss',
						icon: 'trash-o',
						method: 'delete',
						title: 'Eintrag löschen',
					},
				],
			]);
		}

		// SCHOOL
		const title = returnAdminPrefix(res.locals.currentUser.roles);
		let provider = getStorageProviders(res);
		provider = (provider || []).map((prov) => {
			// eslint-disable-next-line eqeqeq
			if (prov.value == school.fileStorageType) {
				return Object.assign(prov, {
					selected: true,
				});
			}
			return prov;
		});

		const ssoTypes = getSSOTypes();

		res.render('administration/school', {
			title: `${title}Schule`,
			school,
			schoolMaintanance,
			schoolMaintananceMode,
			systems,
			ldapAddable,
			provider,
			availableSSOTypes: ssoTypes,
			ssoTypes,
			totalStorage,
			systemsHead,
			systemsBody,
			rssHead,
			rssBody,
			hasRSS: rssBody && !!rssBody.length,
			schoolUsesLdap: res.locals.currentSchoolData.ldapSchoolIdentifier,
		});
	},
);

/*

	Change School Year

*/

// Terminate
router.post('/terminateschoolyear', async (req, res) => {
	await api(req).post(`/schools/${res.locals.currentSchool}/maintenance`, {
		json: {
			maintenance: true,
		},
	});

	res.redirect('/administration/school');
});

// Start
router.use('/startschoolyear', async (req, res) => {
	await api(req).post(`/schools/${res.locals.currentSchool}/maintenance`, {
		json: {
			maintenance: false,
		},
	});

	res.redirect('/administration/school');
});

// Start preview LDAP
router.get('/startldapschoolyear', async (req, res) => {
	// Find LDAP-System
	const school = await Promise.resolve(
		api(req).get(`/schools/${res.locals.currentSchool}`, {
			qs: {
				$populate: ['systems'],
			},
		}),
	);
	const system = school.systems.filter(
		// eslint-disable-next-line no-shadow
		system => system.type === 'ldap',
	);

	const ldapData = await Promise.resolve(api(req).get(`/ldap/${system[0]._id}`));

	const bodyClasses = [];
	ldapData.classes.forEach((singleClass) => {
		if (singleClass.uniqueMembers && singleClass.uniqueMembers.length) {
			bodyClasses.push([
				singleClass.className,
				singleClass.ldapDn,
				(singleClass.uniqueMembers || []).join('; '),
			]);
		}
	});

	const bodyUsers = [];
	ldapData.users.forEach((user) => {
		bodyUsers.push([
			user.firstName,
			user.lastName,
			user.email,
			user.ldapUID,
			user.roles.join(),
			user.ldapDn,
			user.ldapUUID,
		]);
	});

	const headUser = ['Vorname', 'Nachname', 'E-Mail', 'uid', 'Rolle(n)', 'Domainname', 'uuid'];
	const headClasses = ['Name', 'Domain', 'Nutzer der Klasse'];

	res.render('administration/ldap-schoolyear-start', {
		title: 'Prüfung der LDAP-Daten für Schuljahreswechsel',
		headUser,
		bodyUsers,
		headClasses,
		bodyClasses,
	});
});


/*
    LDAP SYSTEMS
*/

router.post(
	'/systems/ldap/add',
	permissionsHelper.permissionsChecker('ADMIN_VIEW'),
	async (req, res, next) => {
		// Check if LDAP-System already exists
		const school = await Promise.resolve(
			api(req).get(`/schools/${res.locals.currentSchool}`, {
				qs: {
					$populate: ['systems'],
				},
			}),
		);
		// eslint-disable-next-line no-shadow
		const system = school.systems.filter(system => system.type === 'ldap');

		if (system.length === 1) {
			// LDAP System already available, do not create another one
			res.redirect('/administration/school');
		} else {
			// Create System for LDAP
			const ldapTemplate = {
				type: 'ldap',
				alias: res.locals.currentSchoolData.name,
				ldapConfig: {
					active: false,
					url: 'ldaps://',
					rootPath: '',
					searchUser: '',
					searchUserPassword: '',
					provider: 'general',
					providerOptions: {
						schoolName: res.locals.currentSchoolData.name,
						userPathAdditions: '',
						classPathAdditions: '',
						roleType: 'text',
						userAttributeNameMapping: {
							givenName: 'givenName',
							sn: 'sn',
							dn: 'dn',
							uuid: 'objectGUID',
							uid: 'cn',
							mail: 'mail',
							role: 'description',
						},
						roleAttributeNameMapping: {
							roleStudent: 'student',
							roleTeacher: 'teacher',
							roleAdmin: 'admin',
							roleNoSc: 'no-sc',
						},
						classAttributeNameMapping: {
							description: 'name',
							dn: 'dn',
							uniqueMember: 'member',
						},
					},
				},
			};

			api(req)
				.post('/systems/', { json: ldapTemplate })
				// eslint-disable-next-line no-shadow
				.then((system) => {
					api(req)
						.patch(`/schools/${res.locals.currentSchool}`, {
							json: {
								$push: {
									systems: system._id,
								},
							},
						})
						.then(() => {
							res.redirect(`/administration/systems/ldap/edit/${system._id}`);
						})
						.catch((err) => {
							next(err);
						});
				});
		}
	},
);
router.get(
	'/systems/ldap/edit/:id',
	permissionsHelper.permissionsChecker('ADMIN_VIEW'),
	async (req, res, next) => {
		// Find LDAP-System
		const school = await Promise.resolve(
			api(req).get(`/schools/${res.locals.currentSchool}`, {
				qs: {
					$populate: ['systems'],
				},
			}),
		);
		const system = school.systems.filter(
			// eslint-disable-next-line no-shadow
			system => system._id === req.params.id,
		);

		if (system.length === 1) {
			res.render('administration/ldap-edit', {
				title: 'LDAP bearbeiten',
				system: system[0],
			});
		} else {
			const err = new Error('Not Found');
			err.status = 404;
			next(err);
		}
	},
);
// Verify
router.post(
	'/systems/ldap/edit/:id',
	permissionsHelper.permissionsChecker('ADMIN_VIEW'),
	async (req, res, next) => {
		// Find LDAP-System
		const school = await Promise.resolve(
			api(req).get(`/schools/${res.locals.currentSchool}`, {
				qs: {
					$populate: ['systems'],
				},
			}),
		);
		const system = school.systems.filter(
			// eslint-disable-next-line no-shadow
			system => system._id === req.params.id,
		);

		// Classes acitve
		let classesPath = req.body.classpath;
		if (req.body.activateclasses !== 'on') {
			classesPath = '';
		}

		let ldapURL = req.body.ldapurl;
		if (!ldapURL.startsWith('ldaps')) {
			if (ldapURL.includes('ldap')) {
				ldapURL = ldapURL.replace('ldap', 'ldaps');
			} else {
				ldapURL = `ldaps://${ldapURL}`;
			}
		}

		api(req)
			.patch(`/systems/${system[0]._id}`, {
				json: {
					alias: req.body.ldapalias,
					ldapConfig: {
						active: false,
						url: ldapURL,
						rootPath: req.body.rootpath,
						searchUser: req.body.searchuser,
						searchUserPassword: req.body.searchuserpassword,
						provider: req.body.ldaptype,
						providerOptions: {
							schoolName: res.locals.currentSchoolData.name,
							userPathAdditions: req.body.userpath,
							classPathAdditions: classesPath,
							roleType: req.body.roletype,
							userAttributeNameMapping: {
								givenName: req.body.givenName,
								sn: req.body.sn,
								dn: req.body.dn,
								uuid: req.body.uuid,
								uid: req.body.uid,
								mail: req.body.mail,
								role: req.body.role,
							},
							roleAttributeNameMapping: {
								roleStudent: req.body.studentrole,
								roleTeacher: req.body.teacherrole,
								roleAdmin: req.body.adminrole,
								roleNoSc: req.body.noscrole,
							},
							classAttributeNameMapping: {
								description: req.body.classdescription,
								dn: req.body.classdn,
								uniqueMember: req.body.classuniquemember,
							},
						},
					},
				},
			})
			.then(() => {
				api(req)
					.get(`/ldap/${system[0]._id}`)
					.then((data) => {
						res.json(data);
					});
			})
			.catch(() => {
				res.json('{}');
			});
	},
);

// Activate
router.post(
	'/systems/ldap/activate/:id',
	permissionsHelper.permissionsChecker('ADMIN_VIEW'),
	async (req, res, next) => {
		// Find LDAP-System
		const school = await Promise.resolve(
			api(req).get(`/schools/${res.locals.currentSchool}`, {
				qs: {
					$populate: ['systems'],
				},
			}),
		);
		const system = school.systems.filter(
			// eslint-disable-next-line no-shadow
			system => system._id === req.params.id,
		);

		api(req)
			.patch(`/systems/${system[0]._id}`, {
				json: {
					'ldapConfig.active': true,
				},
			})
			.then(() => api(req).patch(`/schools/${school._id}`, {
				json: {
					ldapSchoolIdentifier: system[0].ldapConfig.rootPath,
				},
			}))
			.then(() => {
				res.json('success');
			})
			.catch(() => {
				res.json('error');
			});
	},
);

module.exports = router;
