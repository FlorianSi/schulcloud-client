/*
 * One Controller per layout view
 */

const _ = require('lodash');
const express = require('express');
const router = express.Router();
const authHelper = require('../helpers/authentication');
const api = require('../api');
const moment = require('moment');
moment.locale('de');
const recurringEventsHelper = require('../helpers/recurringEvents');


// secure routes
router.use(authHelper.authChecker);

router.get('/', function (req, res, next) {
    // we display time from 7 a.m. to 5 p.m.
    const timeStart = 7;
    const timeEnd = 17;
    const numHours = timeEnd - timeStart;
    const numMinutes = numHours * 60;
    const hours = [];

    for(let j = 0; j <= numHours; j++) {
        hours.push(j + timeStart);
    }
    const start = new Date();
    start.setHours(timeStart,0,0,0);
    const end = new Date();
    end.setHours(timeEnd,0,0,0);

    const currentTime = new Date();
    let currentTimePercentage = 100 * (((currentTime.getHours() - timeStart) * 60) + currentTime.getMinutes()) / numMinutes;
    if(currentTimePercentage < 0) currentTimePercentage = 0;
    else if(currentTimePercentage > 100) currentTimePercentage = 100;

    const eventsPromise = api(req).get('/calendar/', {
        qs: {
            all: true,
            until: end.toLocalISOString()
        }
    }).then(events => {
        // because the calender service is *§$" and is not
        // returning recurring events for a given time period
        // now we have to load all events from the beginning of time
        // until end of the current day, map recurring events and
        // display only the correct ones.
        // I'm not happy with the solution but don't see any other less
        // crappy way for this without changing the
        // calendar service in it's core.

        return Promise.all(events.map(event => recurringEventsHelper.mapEventProps(event, req))).then(events => {
            events = [].concat.apply([], events.map(recurringEventsHelper.mapRecurringEvent)).filter(event => {
                const eventStart = new Date(event.start);
                const eventEnd = new Date(event.end);

                return eventStart < end && eventEnd > start;
            });


            return (events || []).map(event => {
                const eventStart = new Date(event.start);
                let eventEnd = new Date(event.end);

                // cur events that are too long
                if(eventEnd > end) {
                    eventEnd = end;
                    event.end = eventEnd.toLocalISOString();
                }

                // subtract timeStart so we can use these values for left alignment
                const eventStartRelativeMinutes = ((eventStart.getUTCHours() - timeStart) * 60) + eventStart.getMinutes();
                const eventEndRelativeMinutes = ((eventEnd.getUTCHours() - timeStart) * 60) + eventEnd.getMinutes();
                const eventDuration = eventEndRelativeMinutes - eventStartRelativeMinutes;

                event.comment = moment.utc(eventStart).format('kk:mm') + ' - ' + moment.utc(eventEnd).format('kk:mm');
                event.style = {
                    left: 100 * (eventStartRelativeMinutes / numMinutes),  // percent
                    width: 100 * (eventDuration / numMinutes)  // percent
                };

                return event;
            });
        });
    }).catch(_ => []);

    const homeworksPromise = api(req).get('/homework/', {
        qs: {
            $populate: ['courseId'],
            $sort: 'dueDate',
            archived : {$ne: res.locals.currentUser._id },
            'dueDate': {
                $gte: new Date().getTime(),
                $lte: new Date(new Date().setFullYear(new Date().getFullYear() + 1))
            }
        }
    }).then(data => data.data.map(homeworks => {
        homeworks.secondaryTitle = moment(homeworks.dueDate).fromNow();
        if (homeworks.courseId != null) {
            homeworks.title = '['+homeworks.courseId.name+'] ' + homeworks.name;
            homeworks.background = homeworks.courseId.color;
        } else {
            homeworks.title = homeworks.name;
            homeworks.private = true;
        }
        homeworks.url = '/homework/' + homeworks._id;
        homeworks.content = homeworks.description;
        return homeworks;
    }));

    function sortFunction(a, b) {
        if (a.displayAt === b.displayAt) {
            return 0;
        }
        else {
            return (a.displayAt < b.displayAt) ? 1 : -1;
        }
    }
    //Somehow $lte doesn't work in normal query so I manually put it into a request
    const newsPromise = api(req).get('/news/',{
        qs: {
            schoolId : res.locals.currentSchool,
            'displayAt': {
                $lte: new Date().getTime()
            }
        }
    }).then(news => news.data.map(news => {
            news.url = '/news/' + news._id;
            news.secondaryTitle = moment(news.displayAt).fromNow();
            return news;
    }).sort(sortFunction).slice(0,3));

    let newestReleasePromise = api(req).get('/releases', {
        qs:{
            $limit: 1,
            $sort: {
                createdAt: -1
            }
        }
    }).then(({data}) => data);

    Promise.all([
        eventsPromise,
        homeworksPromise,
        newsPromise,
        newestReleasePromise
    ]).then(([events, homeworks, news, newestReleases]) => {

        homeworks.sort((a,b) => {
            if(a.dueDate > b.dueDate) {
                return 1;
            } else {
                return -1;
            }
        });

        let user = res.locals.currentUser || {};
        let userPreferences = user.preferences || {};
        let newestRelease = newestReleases[0] || {};
        let newRelease = !!(Date.parse(userPreferences.releaseDate) < Date.parse(newestRelease.createdAt));

        if(newRelease || !userPreferences.releaseDate) {
            api(req).patch('/users/' + user._id, {
                json: {"preferences.releaseDate" : newestRelease.createdAt}
            }).catch((error) => {});
        }

        res.render('dashboard/dashboard', {
            title: 'Übersicht',
            events,
            eventsDate: moment().format('dddd, DD. MMMM YYYY'),
            homeworks: homeworks.filter(function(task){return !task.private;}).slice(0, 4),
            myhomeworks: homeworks.filter(function(task){return task.private;}).slice(0, 4),
            news,
            hours,
            currentTimePercentage,
            showNewReleaseModal: newRelease,
            currentTime: moment(currentTime).format('HH:mm'),
        });
    });
});


module.exports = router;
