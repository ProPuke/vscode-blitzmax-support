'use strict'

import {
	StackFrame, Scope, Variable,
	StoppedEvent, ContinuedEvent, OutputEvent
} from 'vscode-debugadapter'
import { DebugProtocol } from 'vscode-debugprotocol'
import { BmxDebugSession } from './bmxruntime'
import { EOL } from 'os'
import * as vscode from 'vscode'
import * as path from 'path'
import { waitFor } from './common'
import * as awaitNotify from 'await-notify'

enum BmxDebuggerState {
	AwaitingEventName
}

interface BmxDebuggerEvent {
	name: string
	extra?: string
	data: string[]
}

export interface BmxDebugStackFrame extends StackFrame {
	presentationHint?: 'normal' | 'label' | 'subtle'
	isAppStack?: boolean
}

export interface BmxDebugScope extends Scope {
	parent: BmxDebugStackFrame
}

export interface BmxDebugVariable extends Variable {
	fuzzyNames: string[]
	defineType: string
}

interface BmxCachedDump {
	data: string[]
}

export class BmxDebugger {

	showEmptyScopes: boolean = true

	session: BmxDebugSession
	state: BmxDebuggerState = BmxDebuggerState.AwaitingEventName
	currentEvent: BmxDebuggerEvent
	eventQueue: BmxDebuggerEvent[] = []
	private eventProcess = new awaitNotify.Subject()
	private processingVariables: boolean
	private nextReferenceId: number
	stacks: BmxDebugStackFrame[]
	scopes: BmxDebugScope[]
	cachedDumpForReference: BmxCachedDump[]
	referenceVariables: BmxDebugVariable[]
	variableMap: Map<string, BmxDebugVariable>

	constructor( session: BmxDebugSession ) {
		this.session = session
	}

	sendInputToDebugger( key: string ) {
		if(this.session.bmxProcess.stdin) this.session.bmxProcess.stdin.write( key + '\n' )
	}

	onDebugOutput( output: string ) {
		for ( let i = 0; i < output.split( EOL ).length; i++ ) {
			const line = output.split( EOL )[i]
			if ( line.length <= 0 ) continue
			//console.log('D: ' + line)

			// Is this relevant to the debugger?
			if ( line.startsWith( '~>' ) ) {
				// Does the current event have a name?
				// This will create a new event
				if ( !this.currentEvent || !this.currentEvent.name ) {
					if ( line.length > 2 ) {

						if ( line.includes( ':' ) ) {
							this.currentEvent = {
								name: line.slice( 2, line.lastIndexOf( ':' ) - line.length ),
								extra: line.substr( line.lastIndexOf( ':' ) + 1 ),
								data: []
							}
						} else if ( line.includes( '@' ) ) {
							this.currentEvent = {
								name: line.slice( 2, line.lastIndexOf( '@' ) - line.length ),
								extra: line.substr( line.lastIndexOf( '@' ) + 1 ),
								data: []
							}
						} else {
							this.currentEvent = { name: line.slice( 2 ), data: [] }
						}
					}

					continue
				}

				// Data and end of event
				if ( line.length > 2 ) {
					// Add to data
					if ( line.length > 3 ) {
						this.currentEvent.data.push( line.slice( 2 ) )
					}
				} else {
					// End of event

					// Cleanup
					if ( this.currentEvent.name.endsWith( '{' ) )
						this.currentEvent.name = this.currentEvent.name.slice( 0, -1 )
					if ( this.currentEvent.extra ) {
						if ( this.currentEvent.extra.endsWith( '{' ) )
							this.currentEvent.extra = this.currentEvent.extra.slice( 0, -1 )
						if ( this.currentEvent.extra.length <= 0 )
							this.currentEvent.extra = undefined
					}

					// Send to event queue or process internally
					if ( !this.isInternalEvent( this.currentEvent ) ) {
						//console.log('Queued Debugger Event: ' + this.currentEvent.name)
						this.eventQueue.push( this.currentEvent )
						this.eventProcess.notify()
					} else {
						//console.log('Internal Debugger Event: ' + this.currentEvent.name)
					}

					// Reset
					this.currentEvent = { name: '', data: [] }
				}
			} else {
				// This is not debug related, output to stderr
				this.session.sendEvent( new OutputEvent( line, 'stderr' ) )
			}
		}
	}

	isInternalEvent( event: BmxDebuggerEvent ): boolean {
		switch ( event.name ) {
			case 'DebugStop':
			case 'Debug':
			case 'Unhandled Exception':
				this.cachedDumpForReference = []
				this.session.isDebugging = true
				this.session.sendEvent( new StoppedEvent( event.name, BmxDebugSession.THREAD_ID ) )

				// Easy info about unhandled exceptions
				if ( event.name == 'Unhandled Exception' && event.extra )
					vscode.window.showErrorMessage(
						event.name + ': ' +
						event.extra.replace( '.', '.\n' ).replace( '\n\n', '\n' ),
						{ modal: true }
					)
				return true

			default:
				return false
		}
	}

	getNextEvent(): BmxDebuggerEvent | void {
		if ( this.eventQueue && this.eventQueue.length > 0 ) {
			return this.eventQueue.pop()
		}
	}

	getNextReferenceId(): number {
		this.nextReferenceId++
		return this.nextReferenceId
	}

	resetReferenceId() {
		this.nextReferenceId = 0
	}

	isRootScopeReference( ref: number ): boolean {
		for ( let i = 0; i < this.scopes.length; i++ ) {
			const scope = this.scopes[i]
			if ( !scope || !scope.variablesReference ) continue
			if ( scope.variablesReference == ref ) return true
		}
		return false
	}
	
	isAppStack( id: number ): boolean {
		for ( let i = 0; i < this.stacks.length; i++ ) {
			const stacks = this.stacks[i]
			if ( !stacks || !stacks.id ) continue
			if ( stacks.id == id && stacks.isAppStack ) return true
		}
		return false
	}

	convertToVariable( str: string ): BmxDebugVariable {
		let value: string = ''
		let name: string = ''

		if ( str.includes( '=' ) ) {
			value = str.slice( str.lastIndexOf( '=' ) + 1 )
			name = str.slice( 0, str.length - value.length - 1 )
		} else {
			value = ''
			name = str
		}

		let variable = {
			name: name, value: value, defineType: name.substr( 0, name.indexOf( ' ' ) ),
			variablesReference: 0,
			fuzzyNames: [
				name.toLowerCase(),
				name.substring( name.indexOf( ' ' ) + 1, name.lastIndexOf( ':' ) ).toLowerCase(),
				name.slice( name.indexOf( ' ' ) + 1 ).toLowerCase()
			]
		}

		// Do we need to reference this variable in the future?
		if ( value.startsWith( '$' ) && !value.endsWith( '}' ) ) {
			variable.variablesReference = this.getNextReferenceId()
			this.referenceVariables.push( variable )
		}

		return variable
	}

	// From runtime
	//
	restartRequest() {
		this.variableMap = new Map()
	}

	async evaluateRequest( response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request ): Promise<DebugProtocol.EvaluateResponse> {
		return new Promise( async ( resolve, reject ) => {

			// Wait if variables are currently being processed
			await waitFor( () => !this.processingVariables )
			
			if (!this.variableMap || !this.variableMap.entries) return resolve( response )

			args.expression = args.expression.toLowerCase()

			let varMatch: BmxDebugVariable | undefined = undefined

			for ( let variable of this.variableMap.entries() ) {
				if ( variable[1].fuzzyNames.includes( args.expression ) ) {
					varMatch = variable[1]
					break
				}
			}

			if ( varMatch )
				response.body = {
					result: varMatch.value,
					type: varMatch.defineType,
					variablesReference: varMatch.variablesReference
				}

			return resolve( response )
		} )
	}

	async onStackTraceRequest( response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments ): Promise<DebugProtocol.StackTraceResponse> {
		return new Promise( async ( resolve, reject ) => {
			this.processingVariables = true

			this.resetReferenceId()
			if ( !this.variableMap ) this.variableMap = new Map()
			this.stacks = []
			this.scopes = []
			this.referenceVariables = []

			// Send 't' to debugger to get the stack frames and initial values
			this.sendInputToDebugger( 't' )

			// Wait for the return event
			await this.eventProcess.wait()

			// Capture event
			const event = this.getNextEvent()
			if ( !event || !event.data ) return resolve( response )

			// Prepare the reponse body
			response.body = {
				stackFrames: [],
				totalFrames: 0
			}

			// Process event
			let currentStackFrame: BmxDebugStackFrame | undefined
			let lastStackFrame: BmxDebugStackFrame | undefined
			let lastScope: BmxDebugScope | undefined
			
			for ( let i = 0; i < event.data.length; i++ ) {
				const line = event.data[i]

				// First step is to find the stack frame
				if ( !currentStackFrame ) {
					if ( line.startsWith( '@' ) && line.endsWith( '>' ) ) {
						const pathEnd = line.lastIndexOf( '<' )
						const sourcePath = line.slice( 1, pathEnd - line.length )
						const position = line.slice( pathEnd + 1, -1 ).split( ',' )
						lastScope = undefined

						currentStackFrame = {
							name: '',
							id: this.getNextReferenceId(),
							source: { name: path.basename( sourcePath ), path: sourcePath, sourceReference: 0 },
							line: Number( position[0] ),
							column: Number( position[1] )
						}
					} else if ( lastScope ) {
						// Store all the data (variables) we get for this scope for later use
						//console.log(lastScope.variablesReference+': '+line)
						if ( !this.cachedDumpForReference[lastScope.variablesReference] ) {
							this.cachedDumpForReference[lastScope.variablesReference] = {
								data: []
							}
						}
						this.cachedDumpForReference[lastScope.variablesReference].data.push( line )
					}
				} else {
					// Get the name of this scope from the next line
					if ( currentStackFrame.name.length <= 0 ) {
						if ( line == 'Local <local>' ) {
							currentStackFrame = undefined
							continue
						}

						this.scopes[currentStackFrame.id] = {
							name: line,
							expensive: false,
							variablesReference: this.getNextReferenceId(),
							parent: currentStackFrame
						}
						lastScope = this.scopes[currentStackFrame.id]

						currentStackFrame.name = line
						if ( currentStackFrame.name.includes( ' ' ) ) {
							currentStackFrame.name = currentStackFrame.name.slice(
								currentStackFrame.name.indexOf( ' ' ) + 1
							)
						}
						this.stacks.unshift( currentStackFrame )
						response.body.stackFrames.unshift( currentStackFrame )
						response.body.totalFrames = response.body.stackFrames.length
						//console.log(lastScope.variablesReference+': @'+currentStackFrame.name)
						lastStackFrame = currentStackFrame
						currentStackFrame = undefined
					}
				}
			}
			
			// application stack
			const useAppStack = true
			if ( useAppStack && lastStackFrame ) {
				currentStackFrame = {
					name: `<${this.stacks[this.stacks.length - 1].name}>`,
					id: this.getNextReferenceId(),
					source: lastStackFrame.source,
					line: lastStackFrame.line,
					column: lastStackFrame.column,
					isAppStack: true,
					presentationHint: 'subtle'
				}
				this.stacks.unshift( currentStackFrame )
				response.body.stackFrames.unshift( currentStackFrame )
				response.body.totalFrames = response.body.totalFrames ? response.body.totalFrames++ : 1
			}
			
			return resolve( response )
		} )
	}

	onScopesRequest( response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments ) {
		const scope = this.scopes[args.frameId]
		
		if (this.isAppStack(args.frameId)) {
			response.body = { scopes: [] }
			this.scopes.forEach( s => {
				if (!s.parent.isAppStack)
					response.body.scopes.unshift( s )
			})
		} else if ( this.showEmptyScopes || this.cachedDumpForReference[scope.variablesReference] ) {
			response.body = { scopes: [scope] }
		}
		return response
	}

	async onVariablesRequest( response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments ): Promise<DebugProtocol.VariablesResponse> {
		return new Promise( async ( resolve, reject ) => {
			this.processingVariables = true

			// Prepare the reponse body
			response.body = { variables: [] }

			let convertedVariable: BmxDebugVariable
			
			if ( this.cachedDumpForReference[args.variablesReference] ) {
				// Use the cached response (from initial stack call)
				this.cachedDumpForReference[args.variablesReference].data.forEach( line => {
					convertedVariable = this.convertToVariable( line )
					response.body.variables.push( convertedVariable )
					this.variableMap.set( convertedVariable.name, convertedVariable )
				} )
			} else {
				// Is this a root scope that got no variables from initial call stack?
				if ( this.isRootScopeReference( args.variablesReference ) ) {
					response.body.variables.push( { name: 'no variables', value: '', variablesReference: 0 } )
					this.processingVariables = false
					return resolve( response )
				}

				// Find the variable with the correct reference number
				let variable: BmxDebugVariable | undefined
				let variableIndex: number = 0
				for ( variableIndex; variableIndex < this.referenceVariables.length; variableIndex++ ) {
					const compareVariable = this.referenceVariables[variableIndex]
					if ( compareVariable.variablesReference == args.variablesReference ) {
						variable = compareVariable
						break
					}
				}

				// Did we find a reference?
				if ( !variable ) {
					this.processingVariables = false
					return resolve( response )
				}

				// Send dump request to debugger
				this.sendInputToDebugger( 'd' + variable.value.slice( 1 ) )

				// Wait for the return event
				await this.eventProcess.wait()

				// Capture event
				const event = this.getNextEvent()
				if ( !event || !event.data ) {
					this.processingVariables = false
					return resolve( response )
				}

				// Use event data
				for ( let i = 0; i < event.data.length; i++ ) {
					const line = event.data[i]
					convertedVariable = this.convertToVariable( line )
					response.body.variables.push( convertedVariable )
					this.variableMap.set( convertedVariable.name, convertedVariable )
				}

				// Remove this reference variable
				this.referenceVariables.splice( variableIndex, 1 )
			}

			this.processingVariables = false
			return resolve( response )
		} )
	}

	async continueRequest( response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments ): Promise<DebugProtocol.ContinueResponse> {
		this.variableMap = new Map()
		this.session.isDebugging = false
		this.session.sendEvent( new ContinuedEvent( BmxDebugSession.THREAD_ID ) )
		this.sendInputToDebugger( 'r' )
		return response
	}

	async nextRequest( response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments ): Promise<DebugProtocol.NextResponse> {
		this.session.isDebugging = false
		this.session.sendEvent( new ContinuedEvent( BmxDebugSession.THREAD_ID ) )
		this.sendInputToDebugger( 's' )
		return response
	}

	async stepInRequest( response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments ): Promise<DebugProtocol.StepInResponse> {
		this.session.isDebugging = false
		this.session.sendEvent( new ContinuedEvent( BmxDebugSession.THREAD_ID ) )
		this.sendInputToDebugger( 'e' )
		return response
	}

	async stepOutRequest( response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments ): Promise<DebugProtocol.StepOutResponse> {
		this.session.isDebugging = false
		this.session.sendEvent( new ContinuedEvent( BmxDebugSession.THREAD_ID ) )
		this.sendInputToDebugger( 'l' )
		return response
	}
}