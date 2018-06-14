const express = require('express')
const router = express.Router();
const auth = require('../helpers/authentication');
const api = require('../api');

// This get's executed when we want to tell hydra that the user is authenticated and that he authorized the application
const resolveConsent = (r, w, consent, grantScopes = [], clientId) => {
  // Sometimes the body parser doesn't return an array, so let's fix that.
  if (!Array.isArray(grantScopes)) {
    grantScopes = [grantScopes]
  }

  return api(r).patch('/oauth2proxy/consentRequest/' + consent, {
    json: {
      subject: w.locals.currentUser._id,
      clientId,
      grantScopes
    }
  }).then(consentRequest => w.redirect(consentRequest.redirectUrl));
}

router.get('/consent', auth.authChecker, (r, w) => {
  // This endpoint is hit when hydra initiates the consent flow
  if (r.query.error) {
    // An error occurred (at hydra)
    return w.send(`${r.query.error}<br />${r.query.error_description}`);
  }

  return api(r).get('/oauth2proxy/consentRequest/' + r.query.consent).then(consentRequest => {
    resolveConsent(r, w, r.query.consent, consentRequest.requestedScopes, consentRequest.clientId)
    // return w.render('consent/consent', {
    //   inline: true,
    //   title: 'Login mit Schul-Cloud',
    //   subtitle: '',
    //   client: consentRequest.clientId,
    //   action: `/consent/consent?consent=${r.query.consent}`,
    //   buttonLabel: 'Akzeptieren',
    //   scopes: consentRequest.requestedScopes
    // })
  })
})

router.post('/consent', auth.authChecker, (r, w) => {
  resolveConsent(r, w, r.query.consent, r.body.allowed_scopes, r.body.client_id)
})

module.exports = router
