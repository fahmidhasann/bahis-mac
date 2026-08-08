import { createLogger, format, transports } from 'winston';
import { LOG_FILE_PATH } from './appPaths';

export const log = createLogger({
    transports: [
        new transports.Console({
            level: 'info',
            format: format.combine(
                format.errors({ stack: true }),
                format.colorize(),
                format.timestamp({
                    format: 'HH:mm:ss.SSS',
                }),
                format.printf((info) => `${info.timestamp} [${info.level}] ${info.message}`),
            ),
        }),
        new transports.File({
            filename: LOG_FILE_PATH,
            level: 'silly',
            maxsize: 1048576,
            maxFiles: 1,
            format: format.combine(
                format.errors({ stack: true }),
                format.timestamp({
                    format: 'YYYY-MM-DD HH:mm:ss.SSS',
                }),
                format.printf((info) => {
                    return `${info.timestamp} [${info.label}] ${info.level}: ${info.message} ${info.stack}`;
                }),
            ),
        }),
    ],
});
