import type { TSESTree } from '@typescript-eslint/utils';
import { AST_NODE_TYPES, AST_TOKEN_TYPES } from '@typescript-eslint/utils';
import * as tsutils from 'ts-api-utils';
import * as ts from 'typescript';

import {
  createRule,
  getConstrainedTypeAtLocation,
  getContextualType,
  getDeclaration,
  getParserServices,
  isNullableType,
  isTypeFlagSet,
} from '../util';

type Options = [
  {
    typesToIgnore?: string[];
  },
];
type MessageIds = 'contextuallyUnnecessary' | 'unnecessaryAssertion';

export default createRule<Options, MessageIds>({
  name: 'no-unnecessary-type-assertion',
  meta: {
    docs: {
      description:
        'Disallow type assertions that do not change the type of an expression',
      recommended: 'recommended',
      requiresTypeChecking: true,
    },
    fixable: 'code',
    messages: {
      unnecessaryAssertion:
        'This assertion is unnecessary since it does not change the type of the expression.',
      contextuallyUnnecessary:
        'This assertion is unnecessary since the receiver accepts the original type of the expression.',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          typesToIgnore: {
            description: 'A list of type names to ignore.',
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
      },
    ],
    type: 'suggestion',
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const services = getParserServices(context);
    const checker = services.program.getTypeChecker();
    const compilerOptions = services.program.getCompilerOptions();

    /**
     * Sometimes tuple types don't have ObjectFlags.Tuple set, like when they're being matched against an inferred type.
     * So, in addition, check if there are integer properties 0..n and no other numeric keys
     */
    function couldBeTupleType(type: ts.ObjectType): boolean {
      const properties = type.getProperties();

      if (properties.length === 0) {
        return false;
      }
      let i = 0;

      for (; i < properties.length; ++i) {
        const name = properties[i].name;

        if (String(i) !== name) {
          if (i === 0) {
            // if there are no integer properties, this is not a tuple
            return false;
          }
          break;
        }
      }
      for (; i < properties.length; ++i) {
        if (String(+properties[i].name) === properties[i].name) {
          return false; // if there are any other numeric properties, this is not a tuple
        }
      }
      return true;
    }

    /**
     * Returns true if there's a chance the variable has been used before a value has been assigned to it
     */
    function isPossiblyUsedBeforeAssigned(node: TSESTree.Expression): boolean {
      const declaration = getDeclaration(services, node);
      if (!declaration) {
        // don't know what the declaration is for some reason, so just assume the worst
        return true;
      }

      if (
        // non-strict mode doesn't care about used before assigned errors
        tsutils.isStrictCompilerOptionEnabled(
          compilerOptions,
          'strictNullChecks',
        ) &&
        // ignore class properties as they are compile time guarded
        // also ignore function arguments as they can't be used before defined
        ts.isVariableDeclaration(declaration) &&
        // is it `const x!: number`
        declaration.initializer === undefined &&
        declaration.exclamationToken === undefined &&
        declaration.type !== undefined
      ) {
        // check if the defined variable type has changed since assignment
        const declarationType = checker.getTypeFromTypeNode(declaration.type);
        const type = getConstrainedTypeAtLocation(services, node);
        if (declarationType === type) {
          // possibly used before assigned, so just skip it
          // better to false negative and skip it, than false positive and fix to compile erroring code
          //
          // no better way to figure this out right now
          // https://github.com/Microsoft/TypeScript/issues/31124
          return true;
        }
      }
      return false;
    }

    function isConstAssertion(node: TSESTree.TypeNode): boolean {
      return (
        node.type === AST_NODE_TYPES.TSTypeReference &&
        node.typeName.type === AST_NODE_TYPES.Identifier &&
        node.typeName.name === 'const'
      );
    }

    return {
      TSNonNullExpression(node): void {
        if (
          node.parent.type === AST_NODE_TYPES.AssignmentExpression &&
          node.parent.operator === '='
        ) {
          if (node.parent.left === node) {
            context.report({
              node,
              messageId: 'contextuallyUnnecessary',
              fix(fixer) {
                return fixer.removeRange([
                  node.expression.range[1],
                  node.range[1],
                ]);
              },
            });
          }
          // for all other = assignments we ignore non-null checks
          // this is because non-null assertions can change the type-flow of the code
          // so whilst they might be unnecessary for the assignment - they are necessary
          // for following code
          return;
        }

        const originalNode = services.esTreeNodeToTSNodeMap.get(node);

        const type = getConstrainedTypeAtLocation(services, node.expression);

        if (!isNullableType(type)) {
          if (
            node.expression.type === AST_NODE_TYPES.Identifier &&
            isPossiblyUsedBeforeAssigned(node.expression)
          ) {
            return;
          }

          context.report({
            node,
            messageId: 'unnecessaryAssertion',
            fix(fixer) {
              return fixer.removeRange([node.range[1] - 1, node.range[1]]);
            },
          });
        } else {
          // we know it's a nullable type
          // so figure out if the variable is used in a place that accepts nullable types

          const contextualType = getContextualType(checker, originalNode);
          if (contextualType) {
            // in strict mode you can't assign null to undefined, so we have to make sure that
            // the two types share a nullable type
            const typeIncludesUndefined = isTypeFlagSet(
              type,
              ts.TypeFlags.Undefined,
            );
            const typeIncludesNull = isTypeFlagSet(type, ts.TypeFlags.Null);

            const contextualTypeIncludesUndefined = isTypeFlagSet(
              contextualType,
              ts.TypeFlags.Undefined,
            );
            const contextualTypeIncludesNull = isTypeFlagSet(
              contextualType,
              ts.TypeFlags.Null,
            );

            // make sure that the parent accepts the same types
            // i.e. assigning `string | null | undefined` to `string | undefined` is invalid
            const isValidUndefined = typeIncludesUndefined
              ? contextualTypeIncludesUndefined
              : true;
            const isValidNull = typeIncludesNull
              ? contextualTypeIncludesNull
              : true;

            if (isValidUndefined && isValidNull) {
              context.report({
                node,
                messageId: 'contextuallyUnnecessary',
                fix(fixer) {
                  return fixer.removeRange([
                    node.expression.range[1],
                    node.range[1],
                  ]);
                },
              });
            }
          }
        }
      },
      'TSAsExpression, TSTypeAssertion'(
        node: TSESTree.TSAsExpression | TSESTree.TSTypeAssertion,
      ): void {
        if (
          options.typesToIgnore?.includes(
            context.sourceCode.getText(node.typeAnnotation),
          ) ||
          isConstAssertion(node.typeAnnotation)
        ) {
          return;
        }

        const castType = services.getTypeAtLocation(node);

        if (
          isTypeFlagSet(castType, ts.TypeFlags.Literal) ||
          (tsutils.isObjectType(castType) &&
            (tsutils.isObjectFlagSet(castType, ts.ObjectFlags.Tuple) ||
              couldBeTupleType(castType)))
        ) {
          // It's not always safe to remove a cast to a literal type or tuple
          // type, as those types are sometimes widened without the cast.
          return;
        }

        const uncastType = services.getTypeAtLocation(node.expression);

        if (uncastType === castType) {
          context.report({
            node,
            messageId: 'unnecessaryAssertion',
            fix(fixer) {
              if (node.type === AST_NODE_TYPES.TSTypeAssertion) {
                const openingAngleBracket = context.sourceCode.getTokenBefore(
                  node.typeAnnotation,
                  token =>
                    token.type === AST_TOKEN_TYPES.Punctuator &&
                    token.value === '<',
                )!;
                const closingAngleBracket = context.sourceCode.getTokenAfter(
                  node.typeAnnotation,
                  token =>
                    token.type === AST_TOKEN_TYPES.Punctuator &&
                    token.value === '>',
                )!;
                // < ( number ) > ( 3 + 5 )
                // ^---remove---^
                return fixer.removeRange([
                  openingAngleBracket.range[0],
                  closingAngleBracket.range[1],
                ]);
              }
              // `as` is always present in TSAsExpression
              const asToken = context.sourceCode.getTokenAfter(
                node.expression,
                token =>
                  token.type === AST_TOKEN_TYPES.Identifier &&
                  token.value === 'as',
              )!;
              const tokenBeforeAs = context.sourceCode.getTokenBefore(asToken, {
                includeComments: true,
              })!;
              // ( 3 + 5 )  as  number
              //          ^--remove--^
              return fixer.removeRange([tokenBeforeAs.range[1], node.range[1]]);
            },
          });
        }

        // TODO - add contextually unnecessary check for this
      },
    };
  },
});
