/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { LanguageServiceDefaultsImpl } from './monaco.contribution';
import * as ts from './lib/typescriptServices';
import { TypeScriptWorker } from './tsWorker';
import { onShouldValidateJavacript, onShouldValidateTypescript, MultiFileProject, callWorkerFunction, multiFileProjects, setCurrentMultiFileProject, currentMultiFileProject, getCurrentMultiFileProject } from './multiFileProject/multiFileProject'

import Uri = monaco.Uri;
import Position = monaco.Position;
import Range = monaco.Range;
import Thenable = monaco.Thenable;
import CancellationToken = monaco.CancellationToken;
import IDisposable = monaco.IDisposable;
import { path } from './multiFileProject/path';

//#region utils copied from typescript to prevent loading the entire typescriptServices ---

enum IndentStyle {
	None = 0,
	Block = 1,
	Smart = 2
}

export function flattenDiagnosticMessageText(messageText: string | ts.DiagnosticMessageChain, newLine: '\n'): string {
	if (typeof messageText === "string") {
		return messageText;
	} else {
		let diagnosticChain = messageText;
		let result = "";
		let indent = 0;
		while (diagnosticChain) {
			if (indent) {
				result += newLine;
				for (let i = 0; i < indent; i++) {
					result += "  ";
				}
			}
			result += diagnosticChain.messageText;
			indent++;
			diagnosticChain = diagnosticChain.next;
		}
		return result;
	}
}

function displayPartsToString(displayParts: ts.SymbolDisplayPart[]): string {
	if (displayParts) {
		return displayParts.map((displayPart) => displayPart.text).join("");
	}
	return "";
}

//#endregion

export abstract class Adapter {

	constructor(protected _worker: () => Promise<TypeScriptWorker>, protected _selector: 'typescript' | 'javascript') {
	}

	protected _positionToOffset(uri: Uri, position: monaco.IPosition): number {
		let project = getCurrentMultiFileProject()
		if (!project) {
			return 0
		}
		return project.positionToOffset(uri, position) || 0
	}

	protected _offsetToPosition(uri: Uri, offset: number): monaco.IPosition {
		let project = getCurrentMultiFileProject()
		if (!project) {
			return { lineNumber: 1, column: 1 }
		}

		return project.offsetToPosition(uri, offset) || { lineNumber: 1, column: 1 }
	}

	protected _textSpanToRange(uri: Uri, span: ts.TextSpan): monaco.IRange {
		let p1 = this._offsetToPosition(uri, span.start);
		let p2 = this._offsetToPosition(uri, span.start + span.length);
		let { lineNumber: startLineNumber, column: startColumn } = p1;
		let { lineNumber: endLineNumber, column: endColumn } = p2;
		return { startLineNumber, startColumn, endLineNumber, endColumn };
	}
}

// --- diagnostics --- ---

export class DiagnostcsAdapter extends Adapter {

	private _disposables: IDisposable[] = [];

	constructor(private _defaults: LanguageServiceDefaultsImpl, _selector: 'typescript' | 'javascript',
		worker: () => Promise<TypeScriptWorker>
	) {
		super(worker, _selector);

		const recomputeDiagostics = () => {
			for (const project of multiFileProjects) {
				this._doValidate(project, project.currentFile)
			}
		};
		this._disposables.push(this._defaults.onDidChange(recomputeDiagostics));
		this._disposables.push(this._defaults.onDidExtraLibsChange(recomputeDiagostics));

		let validateProject = (project: MultiFileProject, uri: Uri) => {
			let map = timeoutMap.get(project)
			if (!map) {
				map = new Map()
				timeoutMap.set(project, map)
			}
			let uriString = uri.toString()
			clearTimeout(map.get(uriString))
			map.set(uriString, setTimeout(() => {
				this._doValidate(project, uri)
			}, 500))
		}

		if (this._selector === 'typescript') {
			var onShouldValidate = onShouldValidateTypescript
		}
		else {
			var onShouldValidate = onShouldValidateJavacript
		}

		// Subscribe to multiFileProject updates
		let timeoutMap = new Map<MultiFileProject, Map<string, number>>()
		this._disposables.push(onShouldValidate((ev) => {
			validateProject(ev.project, ev.uri)
		}))
		multiFileProjects.forEach(project => {
			if (project.currentFile) {
				validateProject(project, project.currentFile)
			}
		})
	}

	public dispose(): void {
		this._disposables.forEach(d => d && d.dispose());
		this._disposables = [];
	}

	private _doValidate(resource: MultiFileProject, uri: Uri): void {
		let uriString = uri.toString()
		let extname = path.extname(uriString)
		if (this._selector === 'typescript') {
			if (extname !== '.ts' && extname !== '.tsx') {
				return
			}
		}
		else {
			if (extname !== '.js' && extname !== '.jsx') {
				return
			}
		}
		this._worker().then(worker => {
			return callWorkerFunction(this._selector, () => {
				setCurrentMultiFileProject(resource.id)
				const promises: Promise<ts.Diagnostic[]>[] = [];
				const { noSyntaxValidation, noSemanticValidation } = this._defaults.getDiagnosticsOptions();
				if (!noSyntaxValidation) {
					promises.push(worker.getSyntacticDiagnostics(uriString));
				}
				if (!noSemanticValidation) {
					promises.push(worker.getSemanticDiagnostics(uriString));
				}
				return Promise.all(promises);
			})
		}).then(diagnostics => {
			if (!diagnostics) {
				let model = monaco.editor.getModel(uri)
				if (model) {
					monaco.editor.setModelMarkers(model, this._selector, [])
				}
				resource._onModelMarkers.fire({ uri, markers: null })
				return null;
			}
			const markers = diagnostics
				.reduce((p, c) => c.concat(p), [])
				.map(d => this._convertDiagnostics(uri, d));

			let model = monaco.editor.getModel(uri)
			if (model) {
				monaco.editor.setModelMarkers(model, this._selector, markers)
			}

			resource._onModelMarkers.fire({ uri, markers})
		}).then(undefined, err => {
			console.error(err);
		});
	}

	private _convertDiagnostics(resource: Uri, diag: ts.Diagnostic): monaco.editor.IMarkerData {
		const { lineNumber: startLineNumber, column: startColumn } = this._offsetToPosition(resource, diag.start);
		const { lineNumber: endLineNumber, column: endColumn } = this._offsetToPosition(resource, diag.start + diag.length);

		return {
			severity: monaco.MarkerSeverity.Error,
			startLineNumber,
			startColumn,
			endLineNumber,
			endColumn,
			message: flattenDiagnosticMessageText(diag.messageText, '\n')
		};
	}
}

// --- suggest ------

interface MyCompletionItem extends monaco.languages.CompletionItem {
	uri: Uri;
	position: Position;
}

export class SuggestAdapter extends Adapter implements monaco.languages.CompletionItemProvider {

	public get triggerCharacters(): string[] {
		return ['.'];
	}

	provideCompletionItems(model: monaco.editor.IReadOnlyModel, position: Position, _context: monaco.languages.CompletionContext, token: CancellationToken): Thenable<monaco.languages.CompletionList> {
		const wordInfo = model.getWordUntilPosition(position);
		const wordRange = new Range(position.lineNumber, wordInfo.startColumn, position.lineNumber, wordInfo.endColumn);
		const resource = model.uri;
		const offset = this._positionToOffset(resource, position);

		return this._worker().then(worker => {
			return callWorkerFunction(this._selector, () => {
				return worker.getCompletionsAtPosition(resource.toString(), offset);
			})
		}).then(info => {
			if (!info) {
				return;
			}
			let suggestions: MyCompletionItem[] = info.entries.map(entry => {
				let range = wordRange;
				if (entry.replacementSpan) {
					const p1 = model.getPositionAt(entry.replacementSpan.start);
					const p2 = model.getPositionAt(entry.replacementSpan.start + entry.replacementSpan.length);
					range = new Range(p1.lineNumber, p1.column, p2.lineNumber, p2.column);
				}

				return {
					uri: resource,
					position: position,
					range: range,
					label: entry.name,
					insertText: entry.name,
					sortText: entry.sortText,
					kind: SuggestAdapter.convertKind(entry.kind)
				};
			});

			return {
				suggestions
			};
		});
	}

	resolveCompletionItem(_model: monaco.editor.IReadOnlyModel, _position: Position, item: monaco.languages.CompletionItem, token: CancellationToken): Thenable<monaco.languages.CompletionItem> {
		let myItem = <MyCompletionItem>item;
		const resource = myItem.uri;
		const position = myItem.position;

		return this._worker().then(worker => {
			return callWorkerFunction(this._selector, () => {
				return worker.getCompletionEntryDetails(resource.toString(),
				this._positionToOffset(resource, position),
				myItem.label);
			})
		}).then(details => {
			if (!details) {
				return myItem;
			}
			return <MyCompletionItem>{
				uri: resource,
				position: position,
				label: details.name,
				kind: SuggestAdapter.convertKind(details.kind),
				detail: displayPartsToString(details.displayParts),
				documentation: {
					value: displayPartsToString(details.documentation)
				}
			};
		});
	}

	private static convertKind(kind: string): monaco.languages.CompletionItemKind {
		switch (kind) {
			case Kind.primitiveType:
			case Kind.keyword:
				return monaco.languages.CompletionItemKind.Keyword;
			case Kind.variable:
			case Kind.localVariable:
				return monaco.languages.CompletionItemKind.Variable;
			case Kind.memberVariable:
			case Kind.memberGetAccessor:
			case Kind.memberSetAccessor:
				return monaco.languages.CompletionItemKind.Field;
			case Kind.function:
			case Kind.memberFunction:
			case Kind.constructSignature:
			case Kind.callSignature:
			case Kind.indexSignature:
				return monaco.languages.CompletionItemKind.Function;
			case Kind.enum:
				return monaco.languages.CompletionItemKind.Enum;
			case Kind.module:
				return monaco.languages.CompletionItemKind.Module;
			case Kind.class:
				return monaco.languages.CompletionItemKind.Class;
			case Kind.interface:
				return monaco.languages.CompletionItemKind.Interface;
			case Kind.warning:
				return monaco.languages.CompletionItemKind.File;
		}

		return monaco.languages.CompletionItemKind.Property;
	}
}

export class SignatureHelpAdapter extends Adapter implements monaco.languages.SignatureHelpProvider {

	public signatureHelpTriggerCharacters = ['(', ','];

	provideSignatureHelp(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.SignatureHelp> {
		let resource = model.uri;
		return this._worker().then(worker => {
			return callWorkerFunction(this._selector, () => {
				return worker.getSignatureHelpItems(resource.toString(), this._positionToOffset(resource, position))
			})
		}).then(info => {

			if (!info) {
				return;
			}

			let ret: monaco.languages.SignatureHelp = {
				activeSignature: info.selectedItemIndex,
				activeParameter: info.argumentIndex,
				signatures: []
			};

			info.items.forEach(item => {

				let signature: monaco.languages.SignatureInformation = {
					label: '',
					documentation: null,
					parameters: []
				};

				signature.label += displayPartsToString(item.prefixDisplayParts);
				item.parameters.forEach((p, i, a) => {
					let label = displayPartsToString(p.displayParts);
					let parameter: monaco.languages.ParameterInformation = {
						label: label,
						documentation: displayPartsToString(p.documentation)
					};
					signature.label += label;
					signature.parameters.push(parameter);
					if (i < a.length - 1) {
						signature.label += displayPartsToString(item.separatorDisplayParts);
					}
				});
				signature.label += displayPartsToString(item.suffixDisplayParts);
				ret.signatures.push(signature);
			});

			return ret;

		});
	}
}

// --- hover ------

export class QuickInfoAdapter extends Adapter implements monaco.languages.HoverProvider {

	provideHover(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.Hover> {
		let resource = model.uri;

		return this._worker().then(worker => {
			return callWorkerFunction(this._selector, () => {
				return worker.getQuickInfoAtPosition(resource.toString(), this._positionToOffset(resource, position));
			})
		}).then(info => {
			if (!info) {
				return;
			}
			let documentation = displayPartsToString(info.documentation);
			let tags = info.tags ? info.tags.map(tag => {
				const label = `*@${tag.name}*`;
				if (!tag.text) {
					return label;
				}
				return label + (tag.text.match(/\r\n|\n/g) ? ' \n' + tag.text : ` - ${tag.text}`);
			})
				.join('  \n\n') : '';
			let contents = displayPartsToString(info.displayParts);
			return {
				range: this._textSpanToRange(resource, info.textSpan),
				contents: [{
					value: '```js\n' + contents + '\n```\n'
				}, {
					value: documentation + (tags ? '\n\n' + tags : '')
				}]
			};
		});
	}
}

// --- occurrences ------

export class OccurrencesAdapter extends Adapter implements monaco.languages.DocumentHighlightProvider {

	public provideDocumentHighlights(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.DocumentHighlight[]> {
		const resource = model.uri;

		return this._worker().then(worker => {
			return callWorkerFunction(this._selector, () => {
				return worker.getOccurrencesAtPosition(resource.toString(), this._positionToOffset(resource, position));
			})
		}).then(entries => {
			if (!entries) {
				return;
			}
			return entries.map(entry => {
				return <monaco.languages.DocumentHighlight>{
					range: this._textSpanToRange(resource, entry.textSpan),
					kind: entry.isWriteAccess ? monaco.languages.DocumentHighlightKind.Write : monaco.languages.DocumentHighlightKind.Text
				};
			});
		});
	}
}

// --- definition ------

export class DefinitionAdapter extends Adapter {

	public provideDefinition(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.Definition> {
		const resource = model.uri;

		return this._worker().then(worker => {
			return callWorkerFunction(this._selector, () => {
				return worker.getDefinitionAtPosition(resource.toString(), this._positionToOffset(resource, position));
			})
		}).then(entries => {
			if (!entries) {
				return;
			}
			const result: monaco.languages.Location[] = [];
			for (let entry of entries) {
				const uri = Uri.parse(entry.fileName);
				result.push({
					uri: uri,
					range: this._textSpanToRange(uri, entry.textSpan)
				});
			}
			return result;
		});
	}
}

// --- references ------

export class ReferenceAdapter extends Adapter implements monaco.languages.ReferenceProvider {

	provideReferences(model: monaco.editor.IReadOnlyModel, position: Position, context: monaco.languages.ReferenceContext, token: CancellationToken): Thenable<monaco.languages.Location[]> {
		const resource = model.uri;

		return this._worker().then(worker => {
			return callWorkerFunction(this._selector, () => {
				return worker.getReferencesAtPosition(resource.toString(), this._positionToOffset(resource, position));
			})
		}).then(entries => {
			if (!entries) {
				return;
			}
			const result: monaco.languages.Location[] = [];
			for (let entry of entries) {
				const uri = Uri.parse(entry.fileName);
				if (monaco.editor.getModel(uri)) {
					result.push({
						uri: uri,
						range: this._textSpanToRange(uri, entry.textSpan)
					});
				}
			}
			return result;
		});
	}
}

// --- outline ------

export class OutlineAdapter extends Adapter implements monaco.languages.DocumentSymbolProvider {

	public provideDocumentSymbols(model: monaco.editor.IReadOnlyModel, token: CancellationToken): Thenable<monaco.languages.DocumentSymbol[]> {
		const resource = model.uri;

		return this._worker().then(worker => {
			return callWorkerFunction(this._selector, () => {
				return worker.getNavigationBarItems(resource.toString())
			})
		}).then(items => {
			if (!items) {
				return;
			}

			const convert = (bucket: monaco.languages.DocumentSymbol[], item: ts.NavigationBarItem, containerLabel?: string): void => {
				let result: monaco.languages.DocumentSymbol = {
					name: item.text,
					detail: '',
					kind: <monaco.languages.SymbolKind>(outlineTypeTable[item.kind] || monaco.languages.SymbolKind.Variable),
					range: this._textSpanToRange(resource, item.spans[0]),
					selectionRange: this._textSpanToRange(resource, item.spans[0]),
					containerName: containerLabel
				};

				if (item.childItems && item.childItems.length > 0) {
					for (let child of item.childItems) {
						convert(bucket, child, result.name);
					}
				}

				bucket.push(result);
			}

			let result: monaco.languages.DocumentSymbol[] = [];
			items.forEach(item => convert(result, item));
			return result;
		});
	}
}

export class Kind {
	public static unknown: string = '';
	public static keyword: string = 'keyword';
	public static script: string = 'script';
	public static module: string = 'module';
	public static class: string = 'class';
	public static interface: string = 'interface';
	public static type: string = 'type';
	public static enum: string = 'enum';
	public static variable: string = 'var';
	public static localVariable: string = 'local var';
	public static function: string = 'function';
	public static localFunction: string = 'local function';
	public static memberFunction: string = 'method';
	public static memberGetAccessor: string = 'getter';
	public static memberSetAccessor: string = 'setter';
	public static memberVariable: string = 'property';
	public static constructorImplementation: string = 'constructor';
	public static callSignature: string = 'call';
	public static indexSignature: string = 'index';
	public static constructSignature: string = 'construct';
	public static parameter: string = 'parameter';
	public static typeParameter: string = 'type parameter';
	public static primitiveType: string = 'primitive type';
	public static label: string = 'label';
	public static alias: string = 'alias';
	public static const: string = 'const';
	public static let: string = 'let';
	public static warning: string = 'warning';
}

let outlineTypeTable: { [kind: string]: monaco.languages.SymbolKind } = Object.create(null);
outlineTypeTable[Kind.module] = monaco.languages.SymbolKind.Module;
outlineTypeTable[Kind.class] = monaco.languages.SymbolKind.Class;
outlineTypeTable[Kind.enum] = monaco.languages.SymbolKind.Enum;
outlineTypeTable[Kind.interface] = monaco.languages.SymbolKind.Interface;
outlineTypeTable[Kind.memberFunction] = monaco.languages.SymbolKind.Method;
outlineTypeTable[Kind.memberVariable] = monaco.languages.SymbolKind.Property;
outlineTypeTable[Kind.memberGetAccessor] = monaco.languages.SymbolKind.Property;
outlineTypeTable[Kind.memberSetAccessor] = monaco.languages.SymbolKind.Property;
outlineTypeTable[Kind.variable] = monaco.languages.SymbolKind.Variable;
outlineTypeTable[Kind.const] = monaco.languages.SymbolKind.Variable;
outlineTypeTable[Kind.localVariable] = monaco.languages.SymbolKind.Variable;
outlineTypeTable[Kind.variable] = monaco.languages.SymbolKind.Variable;
outlineTypeTable[Kind.function] = monaco.languages.SymbolKind.Function;
outlineTypeTable[Kind.localFunction] = monaco.languages.SymbolKind.Function;

// --- formatting ----

export abstract class FormatHelper extends Adapter {
	protected static _convertOptions(options: monaco.languages.FormattingOptions): ts.FormatCodeOptions {
		return {
			ConvertTabsToSpaces: options.insertSpaces,
			TabSize: options.tabSize,
			IndentSize: options.tabSize,
			IndentStyle: IndentStyle.Smart,
			NewLineCharacter: '\n',
			InsertSpaceAfterCommaDelimiter: true,
			InsertSpaceAfterSemicolonInForStatements: true,
			InsertSpaceBeforeAndAfterBinaryOperators: true,
			InsertSpaceAfterKeywordsInControlFlowStatements: true,
			InsertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
			InsertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
			InsertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: false,
			InsertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: false,
			PlaceOpenBraceOnNewLineForControlBlocks: false,
			PlaceOpenBraceOnNewLineForFunctions: false
		};
	}

	protected _convertTextChanges(uri: Uri, change: ts.TextChange): monaco.editor.ISingleEditOperation {
		return <monaco.editor.ISingleEditOperation>{
			text: change.newText,
			range: this._textSpanToRange(uri, change.span)
		};
	}
}

export class FormatAdapter extends FormatHelper implements monaco.languages.DocumentRangeFormattingEditProvider {

	provideDocumentRangeFormattingEdits(model: monaco.editor.IReadOnlyModel, range: Range, options: monaco.languages.FormattingOptions, token: CancellationToken): Thenable<monaco.editor.ISingleEditOperation[]> {
		const resource = model.uri;

		return this._worker().then(worker => {
			return callWorkerFunction(this._selector, () => {
				return worker.getFormattingEditsForRange(resource.toString(),
					this._positionToOffset(resource, { lineNumber: range.startLineNumber, column: range.startColumn }),
					this._positionToOffset(resource, { lineNumber: range.endLineNumber, column: range.endColumn }),
					FormatHelper._convertOptions(options)
				);
			})
		}).then(edits => {
			if (edits) {
				return edits.map(edit => this._convertTextChanges(resource, edit));
			}
		});
	}
}

export class FormatOnTypeAdapter extends FormatHelper implements monaco.languages.OnTypeFormattingEditProvider {

	get autoFormatTriggerCharacters() {
		return [';', '}', '\n'];
	}

	provideOnTypeFormattingEdits(model: monaco.editor.IReadOnlyModel, position: Position, ch: string, options: monaco.languages.FormattingOptions, token: CancellationToken): Thenable<monaco.editor.ISingleEditOperation[]> {
		const resource = model.uri;

		return this._worker().then(worker => {
			return callWorkerFunction(this._selector, () => {
				return worker.getFormattingEditsAfterKeystroke(resource.toString(),
					this._positionToOffset(resource, position),
					ch, FormatHelper._convertOptions(options));
			})
		}).then(edits => {
			if (edits) {
				return edits.map(edit => this._convertTextChanges(resource, edit));
			}
		});
	}
}
