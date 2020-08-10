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
const comparisonOperators: { [key: string]: Operator} = {
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
      if (expression.type === 'BinaryExpression') {
        const [ a, operatorType, b ] = expression.value;
        if (operatorType.type === 'ComparisonOperator') {
          const operator = comparisonOperators[operatorType.value];
          const getValue = async(parsed): Promise<string | number | null> => {
            const value = await this.evalValue(parsed);
            if (typeof value === 'string') {
              return value;
            }
            else if (value instanceof dbgp.ObjectProperty) {
              return value.address;
            }
            else if (value instanceof dbgp.PrimitiveProperty) {
              return value.value;
            }

            return null;
          };
          const _a = await getValue(a);
          const _b = await getValue(b);

          if (_a !== null && _b !== null) {
            return operator(_a, _b);
          }
        }
        else if (operatorType.type === 'IsOperator') {
          const negativeMode = -1 < operatorType.value.search(/not/ui);
          const valueA = await this.evalValue(a);
          const valueB = await this.evalValue(b);

          let result = false;
          if (valueA instanceof dbgp.ObjectProperty && valueB instanceof dbgp.ObjectProperty) {
            let baseName = `${valueA.fullName}.base`;
            let baseClassNameProperty = await this.session.fetchLatestPropertyWithoutChildren(`${baseName}.__class`);
            while (baseClassNameProperty !== null) {
              // eslint-disable-next-line no-await-in-loop
              baseClassNameProperty = await this.session.fetchLatestPropertyWithoutChildren(`${baseName}.__class`);
              if (baseClassNameProperty instanceof dbgp.PrimitiveProperty) {
                if (valueB.fullName === baseClassNameProperty.value) {
                  result = true;
                  break;
                }
              }

              baseName += '.base';
            }
          }
          else if (valueA instanceof dbgp.Property && (valueB instanceof dbgp.PrimitiveProperty || typeof valueB === 'string')) {
            const typeName = String(valueB instanceof dbgp.PrimitiveProperty ? valueB.value : valueB)
              .toLowerCase()
              .replace(/(?<=\b)int(?=\b)/ui, 'integer');

            if (valueA.type === typeName) {
              result = true;
            }
            else if (typeName === 'primitive') {
              if ([ 'string', 'integer', 'float' ].includes(valueA.type)) {
                result = true;
              }
            }
            else if (typeName === 'number') {
              if ([ 'integer', 'float' ].includes(valueA.type)) {
                result = true;
              }
            }
            else if (valueA instanceof dbgp.ObjectProperty && typeName.startsWith('object:')) {
              const className = typeName.match(/^object:(.*)$/ui)![1];
              if (className.toLowerCase() === valueA.className.toLowerCase()) {
                result = true;
              }
            }
            else if (valueA instanceof dbgp.PrimitiveProperty) {
              const isIntegerLike = !Number.isNaN(parseInt(valueA.value, 10));
              const isFloatLike = isIntegerLike && valueA.value.includes('.');
              const isNumberLike = isIntegerLike || isFloatLike;
              if (typeName === 'integer:like' && isIntegerLike) {
                result = true;
              }
              else if (typeName === 'float:like' && isFloatLike) {
                result = true;
              }
              else if (typeName === 'number:like' && isNumberLike) {
                result = true;
              }
            }
          }
          else if (valueA === null && valueB === 'undefined') {
            result = true;
          }

          if (negativeMode) {
            return !result;
          }
          return result;
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
  private async evalValue(parsed): Promise<string | dbgp.Property | null> {
    if (!('type' in parsed || 'value' in parsed)) {
      return null;
    }

    if (parsed.type === 'PropertyName') {
      const propertyName = parsed.value;
      const property = await this.session.fetchLatestPropertyWithoutChildren(propertyName);
      return property;
    }
    else if (parsed.type === 'Primitive') {
      const primitive = parsed.value;
      if (primitive.type === 'String') {
        return String(primitive.value);
      }

      const number = primitive.value;
      if (number.type === 'Hex') {
        return String(parseInt(number.value, 16));
      }
      return String(number.value);
    }

    return null;
  }
}
