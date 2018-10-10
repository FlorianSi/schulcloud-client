const express = require('express');
const router = express.Router();
const api = require('../api');

// secure routes
router.use(require('../helpers/authentication').authChecker);

router.post('/', function (req, res, next) {
    api(req).post('/helpdesk', {
        json: {
            type: req.body.type,
            subject: req.body.subject,
            category: req.body.category,
            content: {
                role: req.body.content.role,
                desire: req.body.content.desire,
                benefit: req.body.content.benefit,
                acceptanceCriteria: req.body.content.acceptanceCriteria,
                currentState : req.body.content.currentState,
                targetState: req.body.content.targetState,
            },
            userId: res.locals.currentUser._id,
            email: res.locals.currentUser.email ? res.locals.currentUser.email : "",
            schoolId: res.locals.currentSchoolData._id,
            schoolName: res.locals.currentSchoolData.name,
            cloud: res.locals.theme.title
        }
    })
    .then(_ => {
        res.sendStatus(200);
    }).catch(err => {
        res.status((err.statusCode || 500)).send(err);
    });
});

module.exports = router;
