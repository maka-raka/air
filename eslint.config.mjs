import tsParser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tsParser },
    rules: {
      'no-nested-ternary': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'IfStatement > BlockStatement.consequent > IfStatement',
          message: 'Avoid nested if statements; use guard clauses.',
        },
      ],
    },
  },
];
