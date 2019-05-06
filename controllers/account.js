const express = require('express');
const router = express.Router();
const api = require('../api');
const authHelper = require('../helpers/authentication');

// secure routes
router.use(authHelper.authChecker);

router.post('/', function (req, res, next) {
	const { firstName, lastName, email, password, password_new } = req.body;
	const discoverable = !!req.body.discoverable;
        return api(req).patch('/accounts/' + res.locals.currentPayload.accountId, {
            json: {
                password_verification: password,
                password: password_new !== '' ? password_new : undefined
            }
        }).then(() => {
            return api(req).patch('/users/' + res.locals.currentUser._id, {json: {
                firstName,
                lastName,
				email,
				discoverable,
            }}).then(authHelper.populateCurrentUser.bind(this, req, res)).then(_ => {
                res.redirect('/account/');
            });
        }).catch((err) => {
            res.render('account/settings', {title: 'Dein Account', notification: {
                type: 'danger',
                message: err.error.message
            }});
        });
});

router.get('/', function (req, res, next) {
	const isSSO = Boolean(res.locals.currentPayload.systemId);
	const isDiscoverable = res.locals.currentUser.discoverable;
    if (process.env.NOTIFICATION_SERVICE_ENABLED) {
        api(req).get('/notification/devices')
            .then(device => {
                device.map(d => {
                    if (d.token === req.cookies.deviceToken) {
                        Object.assign(d, {selected: true});
                    }
                    return d;
                });
                res.render('account/settings', {
                    title: 'Dein Account',
                    device,
                    userId: res.locals.currentUser._id,
					sso: isSSO,
					isDiscoverable,
                });
            }).catch(err => {
            res.render('account/settings', {
                title: 'Dein Account',
                userId: res.locals.currentUser._id,
				sso: isSSO,
				isDiscoverable,
            });
        });
    } else {
        res.render('account/settings', {
            title: 'Dein Account',
            userId: res.locals.currentUser._id,
			sso: isSSO,
			isDiscoverable,
        });
    }
});

// delete file
router.delete('/settings/device', function (req, res, next) {
    const {name, _id = ''} = req.body;

    api(req).delete('/notification/devices/' + _id).then(_ => {
        res.sendStatus(200);
    }).catch(err => {
        res.status((err.statusCode || 500)).send(err);
    });
});

router.get('/user', function (req, res, next) {
    res.locals.currentUser.schoolName = res.locals.currentSchoolData.name;
    res.json(res.locals.currentUser);
});

router.post('/preferences', (req, res, next) => {
    const {attribute} = req.body;

    return api(req).patch('/users/' + res.locals.currentUser._id, {
        json: {["preferences." + attribute.key] : attribute.value}
    }).then(() => {
        return "Präferenzen wurden aktualisiert!";
    }).catch((err) => {
        return "Es ist ein Fehler bei den Präferenzen aufgetreten!";
    });
});

module.exports = router;
