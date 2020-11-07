
import { assert, detectExpressionType, isSimpleName, unwrapExp, genId } from '../utils'


export function makeComponent(node, makeEl) {
    let propList = node.attributes;
    let binds = [];
    let head = [];
    let forwardAllEvents = false;
    let injectGroupCall = 0;
    let spreading = false;
    let options = [];
    let dynamicComponent;

    if(node.name == 'component') {
        assert(node.elArg);
        dynamicComponent = node.elArg[0] == '{' ? unwrapExp(node.elArg) : node.elArg;
    }

    let passOption = {};

    if(node.body && node.body.length) {
        let slots = {};
        let defaultSlot = {
            name: 'default',
            type: 'slot'
        }
        defaultSlot.body = node.body.filter(n => {
            if(n.type != 'slot') return true;
            let rx = n.value.match(/^\#slot:(\S+)/);
            if(rx) n.name = rx[1];
            else n.name = 'default';
            assert(!slots[n], 'double slot');
            slots[n.name] = n;
        });

        if(!slots.default) slots.default = defaultSlot;
        // TODO: (else) check if defaultSlot is empty

        Object.values(slots).forEach(slot => {
            assert(isSimpleName(slot.name));
            let args = '', setters = '';
            let rx = slot.value && slot.value.match(/^#slot\S*\s+(.*)$/);
            if(rx) {
                let props = rx[1].trim().split(/\s*,\s*/);
                props.forEach(n => {
                    assert(isSimpleName(n), 'Wrong prop for slot');
                });
                args = `let ${props.join(', ')};`;
                setters = ',' + props.map(name => {
                    return `set_${name}: (_${name}) => {${name} = _${name}; $$apply();}`;
                }).join(',\n');
            }

            passOption.slots = true;
            let block = this.buildBlock(slot);
            const convert = block.svg ? '$runtime.svgToFragment' : '$$htmlToFragment';
            head.push(`
                slots.${slot.name} = function($label) {
                    let $childCD = $cd.new();
                    let $tpl = ${convert}(\`${this.Q(block.tpl)}\`);

                    ${args}

                    ${block.source};
                    ${block.name}($childCD, $tpl);
                    $label.parentNode.insertBefore($tpl, $label.nextSibling);

                    return {
                        destroy: () => {
                            $childCD.destroy();
                        }
                        ${setters}
                    }
                }
            `);
        });
    }

    let boundEvents = {};
    let twoBinds = [];
    propList = propList.filter(prop => {
        let name = prop.name;
        let value = prop.value;
        if(name == '@@') {
            forwardAllEvents = true;
            return false;
        } else if(name.startsWith('{...')) {
            spreading = true;
        } else if(name[0] == ':' || name.startsWith('bind:')) {
            let inner, outer;
            if(name[0] == ':') inner = name.substring(1);
            else inner = name.substring(5);
            if(value) outer = unwrapExp(value);
            else outer = inner;
            assert(isSimpleName(inner), `Wrong property: '${inner}'`);
            assert(detectExpressionType(outer) == 'identifier', 'Wrong bind name: ' + outer);
            twoBinds.push(inner);
            let valueName0 = '$$v' + (this.uniqIndex++);
            let valueName = '$$v' + (this.uniqIndex++);
            passOption.props = true;
            passOption.boundProps = true;
            head.push(`props.${inner} = ${outer};`);
            head.push(`boundProps.${inner} = 2;`);
            binds.push(`
                if('${inner}' in $component) {
                    let ${valueName0} = $runtime.$$cloneDeep(props.${inner});
                    let $$_w0 = $watch($cd, () => (${outer}), (value) => {
                        props.${inner} = value;
                        $$_w1.value = $$_w0.value;
                        $component.${inner} = value;
                    }, {ro: true, cmp: $runtime.$$compareDeep, value: ${valueName0}});
                    let $$_w1 = $watch($component.$cd, () => ($component.${inner}), (${valueName}) => {
                        props.${inner} = ${valueName};
                        $$_w0.value = $$_w1.value;
                        ${outer} = ${valueName};
                        $$apply();
                    }, {cmp: $runtime.$$compareDeep, value: ${valueName0}});
                } else console.error("Component ${node.name} doesn't have prop ${inner}");
            `);
            return false;
        } else if(name == 'this') {
            dynamicComponent = unwrapExp(value);
            return false;
        }
        return true;
    });

    if(spreading) {
        passOption.props = true;
        passOption.boundProps = true;
        head.push('let spreadObject = $runtime.$$makeSpreadObject2($cd, props);');
        head.push('boundProps.$$spreading = true;');
        binds.push('spreadObject.emit = $component.push;');
        if(twoBinds.length) {
            head.push(`spreadObject.except(['${twoBinds.join(',')}']);`);
        }
    }

    propList.forEach(prop => {
        let name = prop.name;
        let value = prop.value;
        if(name[0] == '#') {
            assert(!value, 'Wrong ref');
            let name = name.substring(1);
            assert(isSimpleName(name), name);
            this.checkRootName(name);
            binds.push(`${name} = $component;`);
            return;
        } else if(name[0] == '{') {
            value = name;
            name = unwrapExp(name);
            if(name.startsWith('...')) {
                name = name.substring(3);
                assert(detectExpressionType(name) == 'identifier', 'Wrong prop');
                head.push(`spreadObject.spread(() => ${name})`);
                return;
            };
            assert(detectExpressionType(name) == 'identifier', 'Wrong prop');
        } else if(name[0] == '@' || name.startsWith('on:')) {
            if(name[0] == '@') name = name.substring(1);
            else name = name.substring(3);
            let arg = name.split(/[\|:]/);
            let exp, handler, isFunc, event = arg.shift();
            assert(event);

            if(value) exp = unwrapExp(value);
            else {
                if(!arg.length) {
                    // forwarding
                    passOption.events = true;
                    if(forwardAllEvents || boundEvents[event]) head.push(`$runtime.$$addEventForComponent(events, '${event}', $option.events.${event});`);
                    else head.push(`events.${event} = $option.events.${event};`);
                    boundEvents[event] = true;
                    return;
                }
                handler = arg.pop();
            }
            assert(arg.length == 0);
            assert(!handler ^ !exp);

            if(exp) {
                let type = detectExpressionType(exp);
                if(type == 'identifier') {
                    handler = exp;
                    exp = null;
                } else isFunc = type == 'function';
            }

            let callback;
            if(isFunc) {
                callback = exp;
            } else if(handler) {
                this.checkRootName(handler);
                callback = handler;
            } else {
                callback = `($event) => {${this.Q(exp)}}`;
            }

            passOption.events = true;
            if(forwardAllEvents || boundEvents[event]) head.push(`$runtime.$$addEventForComponent(events, '${event}', ${callback});`);
            else head.push(`events.${event} = ${callback};`);
            boundEvents[event] = true;
            return;
        } else if(name == 'class' || name.startsWith('class:')) {
            let metaClass, args = name.split(':');
            if(args.length == 1) {
                metaClass = '$$main';
            } else {
                assert(args.length == 2);
                metaClass = args[1];
                assert(metaClass);
            }
            assert(value);

            const parsed = this.parseText(prop.value);
            let exp = parsed.result;
            let funcName = `$$pf${this.uniqIndex++}`;
            head.push(`
                const ${funcName} = () => $$resolveClass(${exp});
                $class['${metaClass}'] = ${funcName}();

                $watch($cd, ${funcName}, (result) => {
                    $class['${metaClass}'] = result;
                    groupCall();
                }, {ro: true, value: $class['${metaClass}']});
            `);
            passOption.class = true;
            this.use.resolveClass = true;
            injectGroupCall++;
            return;
        }
        assert(isSimpleName(name), `Wrong property: '${name}'`);
        if(value && value.indexOf('{') >= 0) {
            let exp = this.parseText(value).result;
            let fname = '$$pf' + (this.uniqIndex++);
            let valueName = '$$v' + (this.uniqIndex++);
            if(spreading) {
                return head.push(`
                    spreadObject.prop('${name}', () => ${exp});
                `);
            }
            injectGroupCall++;
            passOption.props = true;
            passOption.boundProps = true;
            head.push(`
                let ${fname} = () => (${exp});
                let ${valueName} = ${fname}()
                props.${name} = ${valueName};
                boundProps.${name} = 1;

                $watch($cd, ${fname}, _${name} => {
                    props.${name} = _${name};
                    groupCall();
                }, {ro: true, cmp: $runtime.$$compareDeep, value: $runtime.$$cloneDeep(${valueName})});
            `);
        } else {
            if(value) value = '`' + this.Q(value) + '`';
            else value = 'true';
            if(spreading) {
                head.push(`spreadObject.attr('${name}', ${value});`);
            } else {
                passOption.props = true;
                head.push(`props.${name} = ${value};`);
            }
        }
    });

    let rootHead = [];
    if(passOption.class) {
        rootHead.push(`let $class = {}`);
        options.push('$class');
    }

    if(passOption.slots) {
        rootHead.push('let slots = {};');
        options.push('slots');
    }

    if(passOption.props) {
        rootHead.push('let props = {};');
        options.push('props');
    }

    if(passOption.boundProps) {
        rootHead.push('let boundProps = {};');
        options.push('boundProps');
    }

    if(forwardAllEvents) {
        rootHead.push('let events = Object.assign({}, $option.events);');
        options.push('events');
    } else if(passOption.events) {
        rootHead.push('let events = {};');
        options.push('events');
    }
    if(injectGroupCall) {
        if(injectGroupCall == 1) {
            rootHead.push('let groupCall;');
            binds.push('groupCall = $component.push;');
        } else {
            rootHead.push('let groupCall = $runtime.$$groupCall();');
            binds.push('groupCall.emit = $component.push;');
        }
    }
    if(spreading) head.push('spreadObject.build();');

    const makeSrc = (componentName, brackets) => {
        let scope = false;
        let result = '';
        if(rootHead.length || head.length) {
            scope = true;
            result = `
                ${rootHead.join('\n')};
                ${head.join('\n')};
            `;
        }
        if(binds.length) {
            scope = true;
            result += `
                let $component = $runtime.callComponent($cd, ${componentName}, ${makeEl()}, {${options.join(', ')}});
                if($component) {
                    ${binds.join('\n')};
                }
            `;
        } else {
            result += `
                $runtime.callComponent($cd, ${componentName}, ${makeEl()}, {${options.join(', ')}});
            `;
        }
        if(brackets && scope) return '{' + result + '}';
        return result;
    }

    if(!dynamicComponent) {
        return {bind: `${makeSrc(node.name, true)}`};
    } else {
        let componentName = '$$comp' + (this.uniqIndex++);
        return {bind: `
        {
            const ${componentName} = ($cd, $ComponentConstructor) => {
                ${makeSrc('$ComponentConstructor')}
            };
            let childCD, finalLabel = $runtime.getFinalLabel(${makeEl()});
            $watch($cd, () => (${dynamicComponent}), ($ComponentConstructor) => {
                if(childCD) {
                    childCD.destroy();
                    $runtime.removeElementsBetween(${makeEl()}, finalLabel);
                }
                childCD = null;
                if($ComponentConstructor) {
                    childCD = $cd.new();
                    ${componentName}(childCD, $ComponentConstructor);
                }
            });
        }`};
    }
};
