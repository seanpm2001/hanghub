/**
 * @license Copyright (c) 2003-2019, CKSource - Frederico Knabben. All rights reserved.
 * This file is licensed under the terms of the MIT License (see LICENSE.md).
 */

import debounce from 'lodash.debounce';
import io from 'socket.io-client';
import renderCollaboratorList from './renderCollaboratorList.jsx';

export default class HangHub {
	constructor( socketUrl ) {
		this._socket = io( socketUrl, { autoConnect: false } );
		this._repoName = null;
		this._issueId = null;
		this._user = null;
		this._isRunning = false;
		this._observer = null;
		this._boundInteractWithSocket = this._interactWithSocket.bind( this );
		this._boundUpdatePosition = this._updatePosition.bind( this );
	}

	start() {
		const userLoginMetaElement = document.querySelector( 'meta[name~="user-login"]' );
		const userIdMetaElement = document.querySelector( 'meta[name~="octolytics-actor-id"]' );

		const userLogin = userLoginMetaElement && userLoginMetaElement.getAttribute( 'content' );
		const userId = userIdMetaElement && userIdMetaElement.getAttribute( 'content' );

		if ( this._isRunning || !userLogin ) {
			return;
		}
		this._isRunning = true;
		this._socket.connect();

		document.addEventListener( 'scroll', this._boundUpdatePosition );
		document.addEventListener( 'visibilitychange', this._boundInteractWithSocket );

		this._user = {
			login: userLogin,
			avatar: `https://avatars2.githubusercontent.com/u/${ userId }`,
			id: userId || null,
			state: this._getState()
		};

		this._observer = new window.MutationObserver( debounce( () => {
			this._interactWithSocket();
		}, 70 ) );

		this._observer.observe( document.querySelector( 'body' ), {
			childList: true,
			characterData: true,
			characterDataOldValue: true,
			subtree: true,
			attributes: true
		} );

		this._interactWithSocket();
	}

	stop() {
		this._isRunning = false;

		this._socket.disconnect();

		if ( this._observer ) {
			this._observer.disconnect();
		}

		const hangHubElement = document.getElementById( 'hanghub' );
		const collaboratorCounter = document.getElementById( 'collaborator-counter' );

		// For the case when the user enables and disables the plugin functionality before the HangHub or collaborator counter element
		//  is rendered.
		if ( hangHubElement ) {
			hangHubElement.remove();
		}
		if ( collaboratorCounter ) {
			collaboratorCounter.remove();
		}

		document.removeEventListener( 'scroll', this._boundUpdatePosition );
		document.removeEventListener( 'visibilitychange', this._boundInteractWithSocket );
	}

	_updatePosition() {
		const hangHubElement = document.getElementById( 'hanghub' );
		const sidebarElement = document.getElementById( 'partial-discussion-sidebar' );

		if ( !hangHubElement ) {
			return;
		}

		if ( hangHubElement.getBoundingClientRect().top < 55 ) {
			hangHubElement.style.position = 'fixed';
			hangHubElement.style.top = '40px';
		} else if ( sidebarElement.getBoundingClientRect().bottom > 50 ) {
			hangHubElement.style.position = 'relative';
			hangHubElement.style.top = null;
		}
	}

	_interactWithSocket() {
		const pathRegExp = /\/(\S+)\/(issues|pull)\/(\d+)/g;
		const [ , repoName, pageType, issueId ] = pathRegExp.exec( window.location.pathname ) || [];
		const newState = this._getState();

		if ( this._isUserOnTheSamePage( repoName, issueId, newState ) ) {
			// Avoid redundant repainting.
			if ( document.getElementById( 'hanghub' ) ) {
				return;
			}
		}

		if ( this._hasUserLeftPage( repoName, issueId ) ) {
			this._socket.emit( 'removeUser', { repoName: this._repoName, issueId: this._issueId } );

			this._repoName = null;
			this._issueId = null;

			return;
		}

		this._repoName = repoName;
		this._issueId = issueId;
		this._user.state = newState;

		this._socket.emit( 'setUser', { repoName: this._repoName, issueId: this._issueId, user: this._user }, ( err, users ) => {
			this._renderCollaborators( users, pageType );
			this._renderCollaboratorCounter( users );
			this._updatePosition();
		} );

		this._socket.on( 'refresh', users => {
			this._renderCollaborators( users, pageType );
			this._renderCollaboratorCounter( users );
			this._updatePosition();
		} );
	}

	_renderCollaborators( users, pageType ) {
		let hangHubElement = document.getElementById( 'hanghub' );

		if ( !hangHubElement ) {
			const sidebarElement = document.getElementById( 'partial-discussion-sidebar' );

			if ( !sidebarElement ) {
				return;
			}

			hangHubElement = document.createElement( 'div' );

			// The `discussion-sidebar-item` class is used to inherit default GitHub styles for such elements.
			hangHubElement.className = 'discussion-sidebar-item';
			hangHubElement.id = 'hanghub';

			sidebarElement.appendChild( hangHubElement );
		}

		const filteredUsers = users.filter( user => user.id !== this._user.id );

		renderCollaboratorList( hangHubElement, filteredUsers, pageType );
	}

	_renderCollaboratorCounter( users ) {
		let collaboratorCounter = document.getElementById( 'collaborator-counter' );

		if ( !collaboratorCounter ) {
			const issueHeader = document.querySelector( '.gh-header-meta .TableObject-item--primary' );

			if ( !issueHeader ) {
				return;
			}

			collaboratorCounter = document.createElement( 'span' );
			collaboratorCounter.id = 'collaborator-counter';

			issueHeader.appendChild( collaboratorCounter );
		}
		collaboratorCounter.textContent = ` · ${ this._getNumberOfUsersMessage( users ) }`;
	}

	_getState() {
		if ( document.hidden ) {
			return 'away';
		} else if ( this._isUserMerging() ) {
			return 'merging';
		} else if ( this._isUserEditingComment() ) {
			return 'editing';
		} else if ( this._isUserCommenting() ) {
			return 'commenting';
		} else {
			return 'viewing';
		}
	}

	_isUserCommenting() {
		const newCommentField = document.querySelector( '#new_comment_field' );
		const newInlineCommentElements = document.querySelectorAll( 'textarea[id*="new_inline_comment_discussion"]' );

		if ( newCommentField && newCommentField.value ) {
			return true;
		}
		for ( const element of newInlineCommentElements ) {
			if ( element.value ) {
				return true;
			}
		}
		return false;
	}

	_isUserEditingComment() {
		return !!document.querySelector( 'div.is-comment-editing' );
	}

	_isUserMerging() {
		if ( !document.querySelector( '.merge-branch-form' ) ) {
			return false;
		}

		return getComputedStyle( document.querySelector( '.merge-branch-form' ) ).getPropertyValue( 'display' ) === 'block';
	}

	_hasUserLeftPage( repoName, issueId ) {
		return !repoName || !issueId;
	}

	_isUserOnTheSamePage( repoName, issueId, state ) {
		return this._repoName == repoName && this._issueId == issueId && this._user.state == state;
	}

	_getNumberOfUsersMessage( users ) {
		const numberOfOtherUsersConnected = users.length - 1;

		switch ( numberOfOtherUsersConnected ) {
			case 0:
				return 'no other users connected';
			case 1:
				return '1 other user connected';
			default:
				return `${ numberOfOtherUsersConnected } other users connected`;
		}
	}
}
