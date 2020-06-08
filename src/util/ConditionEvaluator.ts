import * as createPcre from 'pcre-to-regexp';
import { Parser, createParser } from './ConditionParser';
import * as dbgp from '../dbgpSession';

type Operator = (a, b) => boolean;
const not = (predicate): Operator => (a, b): boolean => !predicate(a, b);
const equals: Operator = (a, b) => a === b;
const equalsIgnoreCase: Operator = (a, b) => {
  const containsObjectAddress = typeof a === 'number' || typeof b === 'number';
  if (containsObjectAddress) {
    return a === b;
  }
  return a.toLowerCase() === b.toLocaleLowerCase();
};
const inequality = (sign: string): Operator => {
  return (a, b): boolean => {
    const containsObjectAddress = typeof a === 'number' || typeof b === 'number';
    if (containsObjectAddress) {
      return false;
    }
    const _a = parseInt(a, 10);
    const _b = parseInt(b, 10);
    if (Number.isNaN(_a) || Number.isNaN(_b)) {
      return false;
    }

    if (sign === '<') {
      return _a < _b;
    }
    if (sign === '<=') {
      return _a <= _b;
    }
    if (sign === '>') {
      return _a > _b;
    }
    if (sign === '>=') {
      return _a >= _b;
    }
    return false;
  };
};
const ahkRegexToJsRegex = function(ahkRegex): RegExp {
  const match = ahkRegex.match(/(?<flags>.+)\)(?<pattern>.+)/ui);
  let flags: string, pattern: string;
  if (match?.groups) {
    flags = match.groups.flags;
    pattern = match.groups.pattern;
  }
  else {
    flags = '';
    pattern = ahkRegex;
  }

  return createPcre(`%${pattern}%${flags}`);
};
const regexCompare: Operator = function(input, ahkRegex) {
  const containsObjectAddress = typeof input === 'number' || typeof ahkRegex === 'number';
  if (containsObjectAddress) {
    return false;
  }

  const regex = ahkRegexToJsRegex(ahkRegex);
  return regex.test(input);
};
const operators: { [key: string]: Operator} = {
  '=': equalsIgnoreCase,
  '==': equals,
  '!=': not(equalsIgnoreCase),
  '!==': not(equals),
  '~=': regexCompare,
  '<': inequality('<'),
  '<=': inequality('<='),
  '>': inequality('>'),
  '>=': inequality('>='),
};

export class ConditionalEvaluator {
  private readonly session: dbgp.Session;
  private readonly parser: Parser;
  constructor(session: dbgp.Session, version: 1 | 2) {
    this.session = session;
    this.parser = createParser(version);
  }
  public async eval(expression: string): Promise<boolean> {
    const parsed = this.parser.Expression.parse(expression);
    if ('value' in parsed) {
      const expression = parsed.value.value;

      let primitiveValue;
      if (expression.type === 'LogicalExpression') {
        const [ a, , operatorType, , b ] = expression.value;
        const getValue = async(value): Promise<string | number | null> => {
          if (value.type === 'PropertyName') {
            const propertyName = value.value;
            const property = await this.session.fetchLatestProperty(propertyName);
            if (property === null) {
              return '';
            }
            if (property instanceof dbgp.PrimitiveProperty) {
              return property.value;
            }
            const objectProperty = property as dbgp.ObjectProperty;
            return objectProperty.address;
          }

          const primitive = value.value;
          if (primitive.type === 'String') {
            return String(primitive.value);
          }

          const number = primitive.value;
          if (number.type === 'Hex') {
            return String(parseInt(number.value, 16));
          }
          return String(number.value);
        };
        const _a = await getValue(a);
        const _b = await getValue(b);

        if (_a !== null && _b !== null) {
          const operator = operators[operatorType.value];
          return operator(_a, _b);
        }
      }
      else if (expression.type === 'PropertyName') {
        const propertyName = expression.value;
        const property = await this.session.fetchLatestProperty(propertyName);
        if (property instanceof dbgp.PrimitiveProperty) {
          primitiveValue = property.value;
        }
        else {
          const objectProperty = property as dbgp.ObjectProperty;
          primitiveValue = String(objectProperty.address);
        }
      }
      else if (expression.type === 'Primitive') {
        const primitive = expression.value;
        if (primitive.type === 'String') {
          const string = expression.value;
          primitiveValue = string.value;
        }
        else if (primitive.type === 'Number') {
          const number = expression.value;
          primitiveValue = number.value.value;
        }
        else {
          const boolean = primitive;
          primitiveValue = boolean.value;
        }
      }

      if (typeof primitiveValue === 'string') {
        if (primitiveValue === '0') {
          return false;
        }
        return primitiveValue !== '';
      }
    }
    return false;
  }
}
