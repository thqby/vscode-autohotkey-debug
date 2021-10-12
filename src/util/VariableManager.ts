import * as path from 'path';
import * as DebugAdapter from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { URI } from 'vscode-uri';
import * as dbgp from '../dbgpSession';
import { rtrim } from 'underscore.string';
import { AhkVersion } from './util';
import { equalsIgnoreCase } from './stringUtils';

export const escapeAhk = (str: string, ahkVersion?: AhkVersion): string => {
  return str
    .replace(/"/gu, ahkVersion?.mejor === 2 ? '`"' : '""')
    .replace(/\r\n/gu, '`r`n')
    .replace(/\n/gu, '`n')
    .replace(/\r/gu, '`r')
    .replace(/[\b]/gu, '`b')
    .replace(/\t/gu, '`t')
    .replace(/\v/gu, '`v')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x07]/gu, '`a')
    .replace(/\f/gu, '`f');
};
export const formatProperty = (property: dbgp.Property, ahkVersion?: AhkVersion): string => {
  const formatPrimitiveProperty = (property: dbgp.PrimitiveProperty): string => {
    if (property.type === 'string') {
      return `"${escapeAhk(property.value, ahkVersion)}"`;
    }
    else if (property.type === 'undefined') {
      return 'Not initialized';
    }
    return property.value;
  };

  if (property instanceof dbgp.PrimitiveProperty) {
    return formatPrimitiveProperty(property);
  }

  const objectProperty = property as dbgp.ObjectProperty;
  const maxIndex = objectProperty.maxIndex;
  const isArray = objectProperty.isArray;
  let value = isArray
    ? `${objectProperty.className}(${maxIndex!}) [`
    : `${objectProperty.className} {`;

  const children = objectProperty.children.slice(0, 100);
  for (const child of children) {
    if (child.name === 'base') {
      continue;
    }

    const displayValue = child instanceof dbgp.PrimitiveProperty
      ? formatPrimitiveProperty(child)
      : (child as dbgp.ObjectProperty).className;

    const objectChild = child as dbgp.ObjectProperty;
    if (objectProperty.isArray) {
      if (!objectChild.isIndexKey) {
        continue;
      }

      value += `${displayValue}, `;
      continue;
    }

    const key = objectChild.isIndexKey
      ? String(objectChild.index)
      : objectChild.name;
    value += `${key}: ${displayValue}, `;
  }

  if (children.length === 100) {
    value += '…';
  }

  value = rtrim(value, ', ');
  value += isArray ? ']' : '}';
  return value;
};

const handles = new DebugAdapter.Handles<StackFrame | Scope | Category | Variable>();
export type ScopeName = 'Local' | 'Static' | 'Global';
export type ScopeSelector = '*' | ScopeName;
export type MatcherData = {
  method?: 'include' | 'exclude';
  ignorecase?: boolean;
  pattern?: string;
  static?: boolean;
  builtin?: boolean;
  type?: string;
  className?: string;
};
export type CategoryData = {
  label: string;
  source: ScopeSelector;
  matchers?: MatcherData[];
};
export type Categories = 'Recommend' | Array<ScopeSelector | CategoryData>;

export class StackFrame implements DebugProtocol.StackFrame {
  public readonly dbgpStackFrame: dbgp.StackFrame;
  public readonly id: number;
  public readonly source: DebugAdapter.Source;
  public readonly line: number;
  public readonly name: string;
  public readonly column = 1;
  public readonly session: dbgp.Session;
  constructor(session: dbgp.Session, dbgpStackFrame: dbgp.StackFrame) {
    this.dbgpStackFrame = dbgpStackFrame;
    this.id = handles.create(this);
    this.name = dbgpStackFrame.name;
    this.line = dbgpStackFrame.line;
    const filePath = URI.parse(dbgpStackFrame.fileUri).fsPath;
    this.source = new DebugAdapter.Source(path.basename(filePath), filePath);

    this.session = session;
  }
}
export type StackFrames = StackFrame[] & { isIdle?: boolean };
export class Scope implements DebugAdapter.Scope {
  public readonly session: dbgp.Session;
  public readonly context: dbgp.Context;
  public readonly name: string;
  public readonly variablesReference: number;
  public readonly expensive: boolean;
  constructor(session: dbgp.Session, context: dbgp.Context, expensive = false) {
    this.session = session;
    this.context = context;
    this.name = context.name;
    this.variablesReference = handles.create(this);
    this.expensive = expensive;
  }
  public async createVariables(args: DebugProtocol.VariablesArguments): Promise<Variable[]> {
    const { properties } = await this.session.sendContextGetCommand(this.context);
    return properties.map((property) => {
      return new Variable(this.session, property);
    });
  }
}
export class Category implements Scope {
  public readonly scopes: Scope[];
  public readonly data: CategoryData;
  public readonly variablesReference: number;
  public readonly expensive: boolean;
  public get context(): dbgp.Context {
    return this.scopes[0].context;
  }
  public get session(): dbgp.Session {
    return this.scopes[0].session;
  }
  public get name(): string {
    return this.data.label;
  }
  constructor(scopes: Scope[], categoryData: CategoryData, expensive = false) {
    this.variablesReference = handles.create(this);
    this.expensive = expensive;
    this.scopes = scopes;
    this.data = categoryData;
  }
  public async createVariables(args: DebugProtocol.VariablesArguments): Promise<Variable[]> {
    const sourceScopes = this.scopes.filter((scope) => {
      if (this.data.source === '*') {
        return true;
      }
      const sourceNames = typeof this.data.source === 'string' ? [ this.data.source ] : this.data.source;
      return sourceNames.some((sourceName) => equalsIgnoreCase(scope.name, sourceName));
    });

    const sourceVariables: Variable[] = [];
    for await (const scope of sourceScopes) {
      sourceVariables.push(...await scope.createVariables(args));
    }

    const matchers = this.data.matchers;
    if (!matchers) {
      return sourceVariables;
    }

    let variables: Variable[] = sourceVariables.slice();
    for (const matcher of matchers) {
      variables = variables.filter((variable) => {
        const testers: Array<(() => boolean)> = [];
        if (matcher.pattern) {
          const regex = new RegExp(matcher.pattern, matcher.ignorecase ? 'iu' : 'u');
          testers.push(() => regex.test(variable.name));
        }
        if (matcher.builtin) {
          testers.push(() => {
            if (variable.property.facet === 'Builtin') {
              return true;
            }
            if ((/(^A_)|^\d$/ui).test(variable.name)) {
              return true;
            }
            const globalVariableNames = this.session.ahkVersion.mejor === 2
              ? [ 'Abs', 'ACos', 'Any', 'Array', 'ASin', 'ATan', 'BlockInput', 'BoundFunc', 'Break', 'Buffer', 'CallbackCreate', 'CallbackFree', 'CaretGetPos', 'Catch', 'Ceil', 'Chr', 'Class', 'Click', 'ClipboardAll', 'ClipWait', 'Closure', 'ComCall', 'ComObjActive', 'ComObjArray', 'ComObjConnect', 'ComObject', 'ComObjFlags', 'ComObjFromPtr', 'ComObjGet', 'ComObjQuery', 'ComObjType', 'ComObjValue', 'ComValue', 'ComValueRef', 'Continue', 'ControlAddItem', 'ControlChooseIndex', 'ControlChooseString', 'ControlClick', 'ControlDeleteItem', 'ControlFindItem', 'ControlFocus', 'ControlGetChecked', 'ControlGetChoice', 'ControlGetClassNN', 'ControlGetEnabled', 'ControlGetExStyle', 'ControlGetFocus', 'ControlGetHwnd', 'ControlGetIndex', 'ControlGetItems', 'ControlGetPos', 'ControlGetStyl', 'ControlGetText', 'ControlGetVisible', 'ControlHide', 'ControlHideDropDown', 'ControlMove', 'ControlSen', 'ControlSendText', 'ControlSetChecked', 'ControlSetEnabled', 'ControlSetExStyle', 'ControlSetStyl', 'ControlSetText', 'ControlShow', 'ControlShowDropDown', 'CoordMode', 'Cos', 'Critical', 'DateAdd', 'DateDiff', 'DetectHiddenText', 'DetectHiddenWindows', 'DirCopy', 'DirCreate', 'DirDelete', 'DirExist', 'DirMove', 'DirSelect', 'DllCall', 'Download', 'DriveEject', 'DriveGetCapacity', 'DriveGetFileSystem', 'DriveGetLabel', 'DriveGetList', 'DriveGetSerial', 'DriveGetSpaceFree', 'DriveGetStatus', 'DriveGetStatusCD', 'DriveGetType', 'DriveLock', 'DriveRetract', 'DriveSetLabel', 'DriveUnlock', 'Edit', 'EditGetCurrentCol', 'EditGetCurrentLine', 'EditGetLine', 'EditGetLineCount', 'EditGetSelectedText', 'EditPaste', 'Else', 'Enumerator', 'EnvGet', 'EnvSet', 'Error', 'Exit', 'ExitApp', 'Exp', 'File', 'FileAppend', 'FileCopy', 'FileCreateShortcut', 'FileDelete', 'FileEncoding', 'FileExist', 'FileGetAttrib', 'FileGetShortcut', 'FileGetSize', 'FileGetTime', 'FileGetVersion', 'FileInstall', 'FileMove', 'FileOpen', 'FileRead', 'FileRecycle', 'FileRecycleEmpty', 'FileSelect', 'FileSetAttrib', 'FileSetTime', 'Finally', 'Float', 'Floor', 'For', 'Format', 'FormatTime', 'Func', 'GetKeyName', 'GetKeySC', 'GetKeyState', 'GetKeyVK', 'GetMethod', 'Goto', 'GroupActivate', 'GroupAdd', 'GroupClose', 'GroupDeactivate', 'Gui', 'Gui()', 'GuiCtrlFromHwnd', 'GuiFromHwnd', 'HasBase', 'HasMethod', 'HasProp', 'HotIf', 'Hotkey', 'Hotstring', 'If', 'IL_Ad', 'IL_Creat', 'IL_Destroy', 'ImageSearch', 'IndexError', 'IniDelete', 'IniRead', 'IniWrite', 'InputBox', 'InputHook', 'InstallKeybdHook', 'InstallMouseHook', 'InStr', 'Integer', 'IsLabel', 'IsObject', 'IsSet', 'KeyError', 'KeyHistory', 'KeyWait', 'ListHotkeys', 'ListLines', 'ListVars', 'ListViewGetContent', 'Ln', 'LoadPicture', 'Log', 'Loop', 'Map', 'Max', 'MemberError', 'MemoryError', 'Menu', 'Menu()', 'MenuBar', 'MenuBar()', 'MenuFromHandle', 'MenuSelect', 'MethodError', 'Min', 'Mod', 'MonitorGet', 'MonitorGetCount', 'MonitorGetName', 'MonitorGetPrimary', 'MonitorGetWorkArea', 'MouseClick', 'MouseClickDrag', 'MouseGetPos', 'MouseMove', 'MsgBox', 'Number', 'NumGet', 'NumPut', 'ObjAddRef', 'ObjBindMethod', 'Object', 'ObjGetBase', 'ObjGetCapacity', 'ObjHasOwnPro', 'ObjOwnProp', 'ObjOwnPropCount', 'ObjSetBase', 'ObjSetCapacity', 'OnClipboardChange', 'OnError', 'OnExit', 'OnMessage', 'Ord', 'OSError', 'OutputDebug', 'Pause', 'Persistent', 'PixelGetColor', 'PixelSearch', 'PostMessage', 'Primitive', 'ProcessClose', 'ProcessExist', 'ProcessSetPriority', 'ProcessWait', 'ProcessWaitClose', 'PropertyError', 'Random', 'RegDelete', 'RegDeleteKey', 'RegExMatch', 'RegExMatchInfo', 'RegExReplace', 'RegRead', 'RegWrite', 'Reload', 'Return', 'Round', 'Run', 'RunAs', 'RunWait', 'Send', 'SendLevel', 'SendMessage', 'SendMode', 'SetCapsLockState', 'SetControlDelay', 'SetDefaultMouseSpeed', 'SetKeyDelay', 'SetMouseDelay', 'SetNumLockState', 'SetRegView', 'SetScrollLockState', 'SetStoreCapsLockMode', 'SetTimer', 'SetTitleMatchMode', 'SetWinDelay', 'SetWorkingDir', 'Shutdown', 'Sin', 'Sleep', 'Sort', 'SoundBeep', 'SoundGetInterface', 'SoundGetMute', 'SoundGetName', 'SoundGetVolume', 'SoundPlay', 'SoundSetMute', 'SoundSetVolume', 'SplitPath', 'Sqrt', 'StatusBarGetText', 'StatusBarWait', 'StrCompare', 'StrGet', 'String', 'StrLen', 'StrLower', 'StrPut', 'StrReplace', 'StrSplit', 'StrUpper', 'SubStr', 'Suspend', 'Switch', 'SysGet', 'SysGetIPAddresses', 'Tan', 'TargetError', 'These', 'Thread', 'Throw', 'TimeoutError', 'ToolTip', 'TraySetIcon', 'TrayTip', 'Trim', 'Try', 'Type', 'TypeError', 'Until', 'ValueError', 'VarRef', 'VarSetStrCapacity', 'VerCompare', 'While-loop', 'WinActivate', 'WinActivateBottom', 'WinActive', 'WinClose', 'WinExist', 'WinGetClass', 'WinGetClientPos', 'WinGetControls', 'WinGetControlsHwnd', 'WinGetCount', 'WinGetExStyle', 'WinGetID', 'WinGetIDLast', 'WinGetList', 'WinGetMinMax', 'WinGetPID', 'WinGetPos', 'WinGetProcessName', 'WinGetProcessPath', 'WinGetStyl', 'WinGetText', 'WinGetTitle', 'WinGetTransColor', 'WinGetTransparent', 'WinHide', 'WinKill', 'WinMaximize', 'WinMinimize', 'WinMinimizeAll', 'WinMove', 'WinMoveBottom', 'WinMoveTop', 'WinRedraw', 'WinRestore', 'WinSetAlwaysOnTop', 'WinSetEnabled', 'WinSetExStyle', 'WinSetRegion', 'WinSetStyl', 'WinSetTitle', 'WinSetTransColor', 'WinSetTransparent', 'WinShow', 'WinWait', 'WinWaitActive', 'WinWaitClose', 'ZeroDivisionError' ]
              : [ 'ErrorLevel' ];
            return globalVariableNames.some((name) => equalsIgnoreCase(name, variable.name));
          });
        }
        if (matcher.static) {
          testers.push(() => variable.property.facet === 'Static');
        }
        if (matcher.type) {
          testers.push(() => variable.type === matcher.type);
        }
        if (matcher.className) {
          testers.push(() => variable.className === matcher.className);
        }

        const result = testers.every((tester) => tester());
        if (matcher.method === 'exclude') {
          return !result;
        }
        return result;
      });
    }
    return variables;
  }
}
export class Variable implements DebugProtocol.Variable {
  public readonly hasChildren: boolean;
  public readonly isLoadedChildren: boolean;
  public readonly session: dbgp.Session;
  public readonly property: dbgp.Property;
  public readonly name: string;
  public readonly value: string;
  public readonly variablesReference: number;
  public indexedVariables?: number;
  public namedVariables?: number;
  public readonly type?: string;
  public get isArray(): boolean {
    return this.property instanceof dbgp.ObjectProperty ? this.property.isArray : false;
  }
  public get context(): dbgp.Context {
    return this.property.context;
  }
  public get fullName(): string {
    return this.property.fullName;
  }
  public get className(): string | undefined {
    return this.property instanceof dbgp.ObjectProperty ? this.property.className : undefined;
  }
  public get maxIndex(): number | undefined {
    return this.property instanceof dbgp.ObjectProperty ? this.property.maxIndex : undefined;
  }
  public get children(): dbgp.Property[] | undefined {
    return this.property instanceof dbgp.ObjectProperty ? this.property.children : undefined;
  }
  constructor(session: dbgp.Session, property: dbgp.Property) {
    this.hasChildren = property instanceof dbgp.ObjectProperty;
    this.isLoadedChildren = property instanceof dbgp.ObjectProperty && 0 < property.children.length;

    this.session = session;
    this.property = property;
    this.name = property.name;
    this.value = formatProperty(property, this.session.ahkVersion);
    this.variablesReference = this.hasChildren ? handles.create(this) : 0;
    this.type = property.type;

    if (property instanceof dbgp.ObjectProperty) {
      if (property.isArray && 100 < property.maxIndex!) {
        this.indexedVariables = property.maxIndex;
        this.namedVariables = 1;
      }
    }
  }
  public async createChildren(args: DebugProtocol.VariablesArguments): Promise<Variable[] | undefined> {
    if (!(this.property instanceof dbgp.ObjectProperty)) {
      return undefined;
    }

    let children = this.children;
    if (!this.isLoadedChildren) {
      const reloadedProperty = await this.session.fetchProperty(this.context, this.fullName, 1);
      if (reloadedProperty instanceof dbgp.ObjectProperty) {
        children = reloadedProperty.children;
      }
    }
    if (!children) {
      return undefined;
    }

    const variables: Variable[] = [];
    for await (const property of children) {
      // Fix: [#133](https://github.com/zero-plusplus/vscode-autohotkey-debug/issues/133)
      if (property.fullName.includes('<enum>')) {
        continue;
      }

      if (args.filter) {
        if (args.filter === 'named' && property.isIndexKey) {
          continue;
        }
        if (args.filter === 'indexed') {
          if (!property.isIndexKey) {
            continue;
          }
          const index = property.index!;
          const start = args.start! + 1;
          const end = args.start! + args.count!;
          const contains = start <= index && index <= end;
          if (!contains) {
            continue;
          }
        }
      }

      const variable = new Variable(this.session, property);
      variables.push(variable);
    }
    return variables;
  }
}
export class VariableManager {
  public readonly session: dbgp.Session;
  public readonly categories?: CategoryData[];
  // private readonly scopeByVariablesReference = new Map<number, Scope>();
  // private readonly objectByVariablesReference = new Map<number, dbgp.ObjectProperty>();
  // private readonly stackFramesByFrameId = new Map<number, dbgp.StackFrame>();
  constructor(session: dbgp.Session, categories?: 'Recommend' | Array<ScopeSelector | CategoryData>) {
    this.session = session;
    this.categories = VariableManager.normalizeCategories(categories);
  }
  public static normalizeCategories(categories?: 'Recommend' | Array<ScopeSelector | CategoryData>): CategoryData[] | undefined {
    if (!categories) {
      return undefined;
    }
    if (categories === 'Recommend') {
      return [
        {
          label: 'Local',
          source: 'Local',
        },
        {
          label: 'Global',
          source: 'Global',
          matchers: [
            {
              method: 'exclude',
              builtin: true,
            },
          ],
        },
        {
          label: 'Built-in Global',
          source: 'Global',
          matchers: [ { builtin: true } ],
        },
      ];
    }

    const normalized: CategoryData[] = [];
    for (const category of categories) {
      if (typeof category !== 'string') {
        normalized.push(category);
      }

      switch (category) {
        case 'Global': {
          normalized.push({
            label: 'Global',
            source: 'Global',
          });
          continue;
        }
        case 'Local': {
          normalized.push({
            label: 'Local',
            source: 'Local',
          });
          continue;
        }
        case 'Static': {
          normalized.push({
            label: 'Static',
            source: 'Static',
          });
          continue;
        }
        default: continue;
      }
    }

    return normalized;
  }
  public async createScopes(frameId: number): Promise<DebugProtocol.Scope[]> {
    const defaultScopes = await this.createDefaultScopes(frameId);
    if (!this.categories) {
      return defaultScopes;
    }

    const scopes: DebugAdapter.Scope[] = [];
    for (const categoryData of this.categories) {
      scopes.push(new Category(defaultScopes, categoryData));
    }
    return scopes;
  }
  public getScope(variableReference: number): Scope | Category | undefined {
    const scope = handles.get(variableReference);
    if (scope instanceof Scope || scope instanceof Category) {
      return scope;
    }
    return undefined;
  }
  public getObjectVariable(variableReference: number): Variable | undefined {
    const variable = handles.get(variableReference);
    if (variable instanceof Variable) {
      return variable;
    }
    return undefined;
  }
  public async createVariables(args: DebugProtocol.VariablesArguments): Promise<Variable[] | undefined> {
    const variable = this.getObjectVariable(args.variablesReference);
    if (variable) {
      return variable.createChildren(args);
    }
    const scope = this.getScope(args.variablesReference);
    return scope?.createVariables(args);
  }
  public async createStackFrames(): Promise<StackFrames> {
    const { stackFrames: dbgpStackFrames } = await this.session.sendStackGetCommand();

    return dbgpStackFrames.map((dbgpStackFrame) => {
      return new StackFrame(this.session, dbgpStackFrame);
    });
  }
  public getStackFrame(frameId: number): StackFrame | undefined {
    const stackFrame = handles.get(frameId);
    if (stackFrame instanceof StackFrame) {
      return stackFrame;
    }
    return undefined;
  }
  public async evaluate(name: string, stackFrame?: dbgp.StackFrame): Promise<Variable | undefined> {
    const property = await this.session.evaluate(name, stackFrame);
    if (!property) {
      return undefined;
    }
    return new Variable(this.session, property);
  }
  private async createDefaultScopes(frameId: number): Promise<Scope[]> {
    const stackFrame = this.getStackFrame(frameId);
    if (!stackFrame) {
      throw Error('');
    }
    const { contexts } = await this.session.sendContextNamesCommand(stackFrame.dbgpStackFrame);
    const scopes: Scope[] = [];
    for await (const context of contexts) {
      const scope = new Scope(this.session, context);
      scopes.push(scope);
    }
    return scopes;
  }
}
