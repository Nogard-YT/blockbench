const MirrorModeling = {
	initial_transformer_position: 0,
	isCentered(element) {
		let center = Format.centered_grid ? 0 : 8;
		if (!element.to && element.origin[0] != center) return false;
		if (element.rotation[1] || element.rotation[2]) return false;
		if (element instanceof Cube && !Math.epsilon(element.to[0], MirrorModeling.flipCoord(element.from[0]), 0.01)) return false;

		let checkParent = (parent) => {
			if (parent instanceof Group) {
				if (parent.origin[0] != center) return true;
				if (parent.rotation[1] || parent.rotation[2]) return true;
				return checkParent(parent.parent);
			}
		}
		if (checkParent(element.parent)) return false;
		return true;
	},
	createClone(original, undo_aspects) {
		// Create or update clone
		let center = Format.centered_grid ? 0 : 8;
		let mirror_element = MirrorModeling.cached_elements[original.uuid]?.counterpart;
		let element_before_snapshot;

		if (mirror_element && mirror_element !== original) {
			element_before_snapshot = mirror_element.getUndoCopy(undo_aspects);
			mirror_element.extend(original);

			// Update hierarchy up
			function updateParent(child, child_b) {
				let parent = child.parent;
				let parent_b = child_b.parent;
				if (parent instanceof Group == false || parent == parent_b) return;

				MirrorModeling.updateGroupCounterpart(parent_b, parent);

				updateParent(parent, parent_b);
			}
			updateParent(original, mirror_element);

		} else {
			function getParentMirror(child) {
				let parent = child.parent;
				if (parent instanceof Group == false) return 'root';

				if (parent.origin[0] == center) {
					return parent;
				} else {
					let mirror_group_parent = getParentMirror(parent);
					let mirror_group = new Group(parent);

					flipNameOnAxis(mirror_group, 0, name => true, parent.name);
					mirror_group.origin[0] = MirrorModeling.flipCoord(mirror_group.origin[0]);
					mirror_group.rotation[1] *= -1;
					mirror_group.rotation[2] *= -1;
					mirror_group.isOpen = parent.isOpen;

					let parent_list = mirror_group_parent instanceof Group ? mirror_group_parent.children : Outliner.root;
					let match = parent_list.find(node => {
						if (node instanceof Group == false) return false;
						if (node.name == mirror_group.name && node.rotation.equals(mirror_group.rotation) && node.origin.equals(mirror_group.origin)) {
							return true;
						}
					})
					if (match) {
						return match;
					} else {
						mirror_group.createUniqueName();
						mirror_group.addTo(mirror_group_parent).init();
						return mirror_group;
					}
				}
			}
			let add_to = getParentMirror(original);
			mirror_element = new original.constructor(original).addTo(add_to).init();
		}
		mirror_element.flip(0, center);

		MirrorModeling.insertElementIntoUndo(mirror_element, undo_aspects, element_before_snapshot);

		let {preview_controller} = mirror_element;
		preview_controller.updateTransform(mirror_element);
		preview_controller.updateGeometry(mirror_element);
		preview_controller.updateFaces(mirror_element);
		preview_controller.updateUV(mirror_element);
		return mirror_element;
	},
	updateGroupCounterpart(group, original) {
		group.extend(original);
		group.isOpen = original.isOpen;

		flipNameOnAxis(group, 0, name => true, original.name);
		group.origin[0] = MirrorModeling.flipCoord(group.origin[0]);
		group.rotation[1] *= -1;
		group.rotation[2] *= -1;
	},
	getEditSide() {
		return Math.sign(Transformer.position.x || MirrorModeling.initial_transformer_position) || 1;
	},
	flipCoord(input) {
		if (Format.centered_grid) {
			return -input;
		} else {
			return 16 - input;
		}
	},
	createLocalSymmetry(mesh) {
		// Create or update clone
		let edit_side = MirrorModeling.getEditSide();
		// Delete all vertices on the non-edit side
		let deleted_vertices = {};
		let deleted_vertices_by_position = {};
		function positionKey(position) {
			return position.map(p => Math.round(p*25)/25).join(',');
		}
		for (let vkey in mesh.vertices) {
			if (mesh.vertices[vkey][0] && Math.round(mesh.vertices[vkey][0] * edit_side * 50) < 0) {
				deleted_vertices[vkey] = mesh.vertices[vkey];
				delete mesh.vertices[vkey];
				deleted_vertices_by_position[positionKey(deleted_vertices[vkey])] = vkey;
			}
		}
		// Copy existing vertices back to the non-edit side
		let added_vertices = [];
		let vertex_counterpart = {};
		let center_vertices = [];
		for (let vkey in mesh.vertices) {
			let vertex = mesh.vertices[vkey];
			if (Math.abs(mesh.vertices[vkey][0]) < 0.02) {
				// On Edge
				vertex_counterpart[vkey] = vkey;
				center_vertices.push(vkey);
			} else {
				let position = [MirrorModeling.flipCoord(vertex[0]), vertex[1], vertex[2]];
				let vkey_new = deleted_vertices_by_position[positionKey(position)];
				if (vkey_new) {
					mesh.vertices[vkey_new] = position;
				} else {
					vkey_new = mesh.addVertices(position)[0];
				}
				added_vertices.push(vkey_new);
				vertex_counterpart[vkey] = vkey_new;
			}
		}

		let deleted_faces = {};
		for (let fkey in mesh.faces) {
			let face = mesh.faces[fkey];
			let deleted_face_vertices = face.vertices.filter(vkey => deleted_vertices[vkey] || center_vertices.includes(vkey));
			if (deleted_face_vertices.length == face.vertices.length && !face.vertices.allAre(vkey => center_vertices.includes(vkey))) {
				deleted_faces[fkey] = mesh.faces[fkey];
				delete mesh.faces[fkey];
			}
		}

		let original_fkeys = Object.keys(mesh.faces);
		for (let fkey of original_fkeys) {
			let face = mesh.faces[fkey];
			let deleted_face_vertices = face.vertices.filter(vkey => deleted_vertices[vkey]);
			if (deleted_face_vertices.length && face.vertices.length != deleted_face_vertices.length*2) {
				// cannot flip. restore vertices instead?
				deleted_face_vertices.forEach(vkey => {
					mesh.vertices[vkey] = deleted_vertices[vkey];
					//delete deleted_vertices[vkey];
				})

			} else if (deleted_face_vertices.length) {
				// face across zero line
				//let kept_face_keys = face.vertices.filter(vkey => mesh.vertices[vkey] != 0 && !deleted_face_vertices.includes(vkey));
				let new_counterparts = face.vertices.filter(vkey => !deleted_vertices[vkey]).map(vkey => vertex_counterpart[vkey]);
				face.vertices.forEach((vkey, i) => {
					if (deleted_face_vertices.includes(vkey)) {
						// Across
						//let kept_key = kept_face_keys[i%kept_face_keys.length];
						new_counterparts.sort((a, b) => {
							let a_distance = Math.pow(mesh.vertices[a][1] - deleted_vertices[vkey][1], 2) + Math.pow(mesh.vertices[a][2] - deleted_vertices[vkey][2], 2);
							let b_distance = Math.pow(mesh.vertices[b][1] - deleted_vertices[vkey][1], 2) + Math.pow(mesh.vertices[b][2] - deleted_vertices[vkey][2], 2);
							return b_distance - a_distance;
						})

						let counterpart = new_counterparts.pop();
						if (vkey != counterpart && counterpart) {
							face.vertices.splice(i, 1, counterpart);
							face.uv[counterpart] = face.uv[vkey].slice();
							delete face.uv[vkey];
						}
					}
				})

			} else if (deleted_face_vertices.length == 0) {
				// Recreate face as mirrored
				let new_face_key;
				for (let key in deleted_faces) {
					let deleted_face = deleted_faces[key];
					if (face.vertices.allAre(vkey => deleted_face.vertices.includes(vertex_counterpart[vkey]))) {
						new_face_key = key;
						break;
					}
				}

				let new_face = new MeshFace(mesh, face);
				face.vertices.forEach((vkey, i) => {
					let new_vkey = vertex_counterpart[vkey];
					new_face.vertices.splice(i, 1, new_vkey);
					delete new_face.uv[vkey];
					new_face.uv[new_vkey] = face.uv[vkey].slice();
				})
				new_face.invert();
				if (new_face_key) {
					mesh.faces[new_face_key] = new_face;
				} else {
					[new_face_key] = mesh.addFaces(new_face);
				}
			}

		}
		let {preview_controller} = mesh;
		preview_controller.updateGeometry(mesh);
		preview_controller.updateFaces(mesh);
		preview_controller.updateUV(mesh);
	},
	insertElementIntoUndo(element, undo_aspects, element_before_snapshot) {
		// pre
		if (element_before_snapshot) {
			if (!Undo.current_save.elements[element.uuid]) Undo.current_save.elements[element.uuid] = element_before_snapshot;
		} else {
			if (!Undo.current_save.outliner) Undo.current_save.outliner = MirrorModeling.outliner_snapshot;
		}

		// post
		if (!element_before_snapshot) undo_aspects.outliner = true;
		undo_aspects.elements.safePush(element);
	},
	cached_elements: {}
}

Blockbench.on('init_edit', ({aspects}) => {
	if (!BarItems.mirror_modeling.value) return;

	MirrorModeling.initial_transformer_position = Transformer.position.x;

	if (aspects.elements) {
		MirrorModeling.cached_elements = {};
		MirrorModeling.outliner_snapshot = aspects.outliner ? null : compileGroups(true);
		let edit_side = MirrorModeling.getEditSide();

		aspects.elements.forEach((element) => {
			if (element.allow_mirror_modeling) {
				let is_centered = MirrorModeling.isCentered(element);

				let data = MirrorModeling.cached_elements[element.uuid] = {is_centered};
				if (!is_centered) {
					data.is_original = Math.sign(element.getWorldCenter().x) != edit_side;
					data.counterpart = Painter.getMirrorElement(element, [1, 0, 0]);
					if (!data.counterpart) data.is_original = true;
				}
			}
		})
	} else if (aspects.group || aspects.outliner) {
		MirrorModeling.cached_elements = {};
		let edit_side = MirrorModeling.getEditSide();
		let selected_groups = aspects.outliner ? Group.all.filter(g => g.selected) : [aspects.group];

		// update undo
		if (!Undo.current_save.outliner) Undo.current_save.outliner = compileGroups(true);
		aspects.outliner = true;

		selected_groups.forEach(group => {
			if (group.origin[0] == (Format.centered_grid ? 0 : 8)) return;

			let mirror_group = Group.all.find(g => {
				if (
					Math.epsilon(group.origin[0], MirrorModeling.flipCoord(g.origin[0])) &&
					Math.epsilon(group.origin[1], g.origin[1]) &&
					Math.epsilon(group.origin[2], g.origin[2]) &&
					group.getDepth() == g.getDepth()
				) {
					return true;
				}
			})

			if (mirror_group) {
				MirrorModeling.cached_elements[group.uuid] = {
					counterpart: mirror_group
				}
			}
		})
	}
})
Blockbench.on('finish_edit', ({aspects}) => {
	if (!BarItems.mirror_modeling.value) return;

	if (aspects.elements) {
		aspects.elements = aspects.elements.slice();
		let static_elements_copy = aspects.elements.slice();
		static_elements_copy.forEach((element) => {
			if (element.allow_mirror_modeling) {
				let is_centered = MirrorModeling.isCentered(element);

				if (is_centered && element instanceof Mesh) {
					// Complete other side of mesh
					MirrorModeling.createLocalSymmetry(element);
				}
				if (is_centered) {
					let mirror_element = MirrorModeling.cached_elements[element.uuid]?.counterpart;
					if (mirror_element) {
						MirrorModeling.insertElementIntoUndo(mirror_element, Undo.current_save.aspects, mirror_element.getUndoCopy());
						mirror_element.remove();
						aspects.elements.remove(mirror_element);
					}
				} else {
					// Construct clone at other side of model
					MirrorModeling.createClone(element, aspects);
				}
			}
		})
		if (aspects.group || aspects.outliner) {
			Canvas.updateAllBones();
		}
	} else if (aspects.group || aspects.outliner) {
		let selected_groups = aspects.outliner ? Group.all.filter(g => g.selected) : [aspects.group];

		selected_groups.forEach(group => {
			let mirror_group = MirrorModeling.cached_elements[group.uuid]?.counterpart;
			if (mirror_group) {
				MirrorModeling.updateGroupCounterpart(mirror_group, group);
			}
		})

		aspects.outliner = true;
		Canvas.updateAllBones();
	}
})

// Element property on cube and mesh
new Property(Cube, 'boolean', 'allow_mirror_modeling', {default: true});
new Property(Mesh, 'boolean', 'allow_mirror_modeling', {default: true});

BARS.defineActions(() => {
	
	new Toggle('mirror_modeling', {
		icon: 'align_horizontal_center',
		category: 'edit',
		condition: {modes: ['edit']},
		onChange() {
			Project.mirror_modeling_enabled = this.value;
			MirrorModeling.cached_elements = {};
			updateSelection();
		}
	})
	let allow_toggle = new Toggle('allow_element_mirror_modeling', {
		icon: 'align_horizontal_center',
		category: 'edit',
		condition: {modes: ['edit'], selected: {element: true}, method: () => BarItems.mirror_modeling.value},
		onChange(value) {
			Outliner.selected.forEach(element => {
				if (!element.constructor.properties.allow_mirror_modeling) return;
				element.allow_mirror_modeling = value;
			})
		}
	})
	Blockbench.on('update_selection', () => {
		if (!Condition(allow_toggle.condition)) return;
		let disabled = Outliner.selected.find(el => el.allow_mirror_modeling === false);
		if (allow_toggle.value != !disabled) {
			allow_toggle.value = !disabled;
			allow_toggle.updateEnabledState();
		}
	})
})
