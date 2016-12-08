import React from 'react';
import {browserHistory} from 'react-router';
import { Server } from '../../core/helpers';

const toolsConnectService = Server.service('/ltiTools/connect');
const toolService = Server.service('/ltiTools');

export default {
	connect: (toolId) => {
		let win = window.open("");
		// todo: extract current user id
		toolsConnectService.create({ toolId })
			.then(result => {
				if (result.type === 'url') {
					win.location.href = result.data;
				} else {
					win.document.write(result.data);
				}
			});
	}
};


